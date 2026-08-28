import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import {
  WebhookRequestError,
  type OpenAIRealtimeWebhookReceiver,
} from "./live-gateway-server.ts";
import {
  NoopSanitizedLogger,
  safeReference,
  type SanitizedLogger,
} from "./sanitized-logger.ts";

export interface OpenAISipHeader {
  name: string;
  value: string;
}

export interface OpenAIIncomingSipWebhook {
  id: string;
  type: "realtime.call.incoming";
  createdAt: number;
  callId: string;
  sipHeaders: readonly OpenAISipHeader[];
}

export interface OpenAIIncomingSipWebhookHandler {
  handleIncomingCall(event: OpenAIIncomingSipWebhook): Promise<void>;
}

export interface OpenAIWebhookReceiverConfig {
  secret: string;
  toleranceSeconds?: number;
  maxRememberedWebhookIds?: number;
  now?: () => number;
  logger?: SanitizedLogger;
}

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function signingKey(secret: string): Buffer {
  const trimmed = secret.trim();
  if (!trimmed) throw new Error("OpenAI webhook secret is required");
  const encoded = trimmed.startsWith("whsec_") ? trimmed.slice(6) : trimmed;
  const key = Buffer.from(encoded, "base64");
  if (key.length === 0) throw new Error("OpenAI webhook secret is invalid");
  return key;
}

function signatures(value: string): Buffer[] {
  return value
    .split(/\s+/)
    .flatMap((item) => {
      const [version, encoded] = item.split(",", 2);
      if (version !== "v1" || !encoded) return [];
      try {
        const decoded = Buffer.from(encoded, "base64");
        return decoded.length === 0 ? [] : [decoded];
      } catch {
        return [];
      }
    });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function incomingEvent(value: unknown): OpenAIIncomingSipWebhook | "ignored" {
  const root = record(value);
  if (!root || typeof root.type !== "string") {
    throw new WebhookRequestError(400, "Webhook body is malformed");
  }
  if (root.type !== "realtime.call.incoming") return "ignored";
  const data = record(root.data);
  if (
    typeof root.id !== "string" ||
    typeof root.created_at !== "number" ||
    typeof data?.call_id !== "string" ||
    !Array.isArray(data.sip_headers)
  ) {
    throw new WebhookRequestError(400, "Incoming SIP webhook is malformed");
  }
  const sipHeaders = data.sip_headers.map((item) => {
    const header = record(item);
    if (typeof header?.name !== "string" || typeof header.value !== "string") {
      throw new WebhookRequestError(400, "Incoming SIP headers are malformed");
    }
    return { name: header.name, value: header.value };
  });
  return {
    id: root.id,
    type: "realtime.call.incoming",
    createdAt: root.created_at,
    callId: data.call_id,
    sipHeaders,
  };
}

/** Standard Webhooks verification plus in-process webhook-id deduplication. */
export class VerifiedOpenAIWebhookReceiver
  implements OpenAIRealtimeWebhookReceiver {
  private readonly key: Buffer;
  private readonly toleranceSeconds: number;
  private readonly maximumIds: number;
  private readonly now: () => number;
  private readonly logger: SanitizedLogger;
  private readonly consumer: OpenAIIncomingSipWebhookHandler;
  private readonly deliveries = new Map<string, Promise<void>>();

  constructor(
    config: OpenAIWebhookReceiverConfig,
    consumer: OpenAIIncomingSipWebhookHandler,
  ) {
    this.key = signingKey(config.secret);
    this.toleranceSeconds = config.toleranceSeconds ?? 300;
    this.maximumIds = config.maxRememberedWebhookIds ?? 10_000;
    if (!Number.isInteger(this.toleranceSeconds) || this.toleranceSeconds < 1) {
      throw new Error("OpenAI webhook toleranceSeconds must be positive");
    }
    if (!Number.isInteger(this.maximumIds) || this.maximumIds < 1) {
      throw new Error("OpenAI webhook maxRememberedWebhookIds must be positive");
    }
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
    this.logger = config.logger ?? new NoopSanitizedLogger();
    this.consumer = consumer;
  }

  async handle(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ): Promise<"processed" | "duplicate" | "ignored"> {
    const webhookId = headerValue(headers, "webhook-id")?.trim();
    const timestampText = headerValue(headers, "webhook-timestamp")?.trim();
    const signatureText = headerValue(headers, "webhook-signature")?.trim();
    if (!webhookId || !timestampText || !signatureText) {
      throw new WebhookRequestError(401, "Webhook signature headers are required");
    }
    const timestamp = Number(timestampText);
    if (!Number.isSafeInteger(timestamp)) {
      throw new WebhookRequestError(401, "Webhook timestamp is invalid");
    }
    if (Math.abs(this.now() - timestamp) > this.toleranceSeconds) {
      throw new WebhookRequestError(401, "Webhook timestamp is outside tolerance");
    }
    const expected = createHmac("sha256", this.key)
      .update(webhookId)
      .update(".")
      .update(timestampText)
      .update(".")
      .update(rawBody)
      .digest();
    const valid = signatures(signatureText).some(
      (candidate) =>
        candidate.length === expected.length && timingSafeEqual(candidate, expected),
    );
    if (!valid) throw new WebhookRequestError(401, "Webhook signature is invalid");

    const existing = this.deliveries.get(webhookId);
    if (existing) {
      await existing;
      return "duplicate";
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new WebhookRequestError(400, "Webhook body is not valid JSON");
    }
    const event = incomingEvent(parsed);
    if (event === "ignored") return "ignored";

    if (this.deliveries.size >= this.maximumIds) {
      const oldest = this.deliveries.keys().next().value as string | undefined;
      if (oldest) this.deliveries.delete(oldest);
    }
    const delivery = this.consumer.handleIncomingCall(event);
    this.deliveries.set(webhookId, delivery);
    try {
      await delivery;
      this.logger.info("openai_webhook.processed", {
        webhookRef: safeReference(webhookId),
        eventRef: safeReference(event.id),
      });
      return "processed";
    } catch (error) {
      this.deliveries.delete(webhookId);
      throw error;
    }
  }
}

/** Test/development helper using the same Standard Webhooks signing format. */
export function signOpenAIWebhook(
  secret: string,
  webhookId: string,
  timestamp: number,
  rawBody: Buffer | string,
): string {
  return `v1,${createHmac("sha256", signingKey(secret))
    .update(`${webhookId}.${timestamp}.`)
    .update(rawBody)
    .digest("base64")}`;
}

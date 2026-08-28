import { createHash } from "node:crypto";

import type { MessagingAdapter, OutgoingMessage } from "../contracts.ts";
import {
  NoopSanitizedLogger,
  safeReference,
  type SanitizedLogger,
} from "./sanitized-logger.ts";

const E164 = /^\+[1-9]\d{7,14}$/;
const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PDF_PATH = /\.pdf$/i;

export interface OpenWAWhatsAppAdapterConfig {
  dryRun?: boolean;
  allowRealMessages?: boolean;
  allowUnofficialClient?: boolean;
  baseUrl?: string;
  apiKey?: string;
  sessionId?: string;
  allowedRecipient?: string;
  timeoutMs?: number;
  maxIdempotencyEntries?: number;
  logger?: SanitizedLogger;
}

interface RememberedMessage {
  fingerprint: string;
  result: Promise<{ externalId: string; simulated?: boolean }>;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required for live OpenWA`);
  return value.trim();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function fingerprint(message: OutgoingMessage): string {
  return createHash("sha256").update(JSON.stringify({
    to: message.to,
    body: message.body,
    attachments: message.attachments,
    consent: message.consent ?? null,
  })).digest("hex");
}

function normalizedBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OPENWA_BASE_URL must be a valid URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("OPENWA_BASE_URL must not contain credentials, query, or fragment");
  }
  const localHttp = url.protocol === "http:" && LOCAL_HTTP_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("OPENWA_BASE_URL must use HTTPS, except for localhost loopback");
  }
  if (url.pathname !== "/") {
    throw new Error("OPENWA_BASE_URL must not contain a path");
  }
  return url.origin;
}

function documentFilename(attachment: string): string {
  const pathname = new URL(attachment).pathname;
  const encodedName = pathname.split("/").filter(Boolean).at(-1) ?? "resume.pdf";
  let decodedName: string;
  try {
    decodedName = decodeURIComponent(encodedName);
  } catch {
    decodedName = encodedName;
  }
  const filename = decodedName
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .trim()
    .slice(0, 255);
  return filename || "resume.pdf";
}

/**
 * OpenWA is an independently deployed, unofficial WhatsApp Web gateway. This
 * adapter uses the send-text and send-document REST contracts and never
 * manages sessions, scans QR codes, or starts the OpenWA service.
 */
export class OpenWAWhatsAppAdapter implements MessagingAdapter {
  private readonly dryRun: boolean;
  private readonly baseUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly sessionId: string | undefined;
  private readonly allowedRecipient: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxIdempotencyEntries: number;
  private readonly logger: SanitizedLogger;
  private readonly fetchFn: typeof fetch;
  private readonly messages = new Map<string, RememberedMessage>();

  constructor(
    config: OpenWAWhatsAppAdapterConfig = {},
    fetchFn: typeof fetch = fetch,
  ) {
    this.dryRun = config.dryRun ?? true;
    const configuredBaseUrl = config.baseUrl?.trim();
    this.apiKey = config.apiKey?.trim();
    this.sessionId = config.sessionId?.trim();
    this.allowedRecipient = config.allowedRecipient?.trim();
    this.timeoutMs = config.timeoutMs ?? 8_000;
    this.maxIdempotencyEntries = config.maxIdempotencyEntries ?? 10_000;
    this.logger = config.logger ?? new NoopSanitizedLogger();
    this.fetchFn = fetchFn;

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 500 || this.timeoutMs > 60_000) {
      throw new Error("OpenWA timeoutMs must be an integer from 500 to 60000");
    }
    if (!Number.isInteger(this.maxIdempotencyEntries) || this.maxIdempotencyEntries < 1) {
      throw new Error("OpenWA maxIdempotencyEntries must be a positive integer");
    }
    if (this.allowedRecipient !== undefined && !E164.test(this.allowedRecipient)) {
      throw new Error("OpenWA allowedRecipient must use E.164 format");
    }
    if (!this.dryRun) {
      if (!config.allowRealMessages) {
        throw new Error("Live OpenWA requires an explicit allowRealMessages acknowledgement");
      }
      if (!config.allowUnofficialClient) {
        throw new Error("Live OpenWA requires an explicit unofficial-client risk acknowledgement");
      }
      this.baseUrl = normalizedBaseUrl(required(configuredBaseUrl, "OPENWA_BASE_URL"));
      const apiKey = required(this.apiKey, "OPENWA_API_KEY");
      if (apiKey.length > 512) throw new Error("OPENWA_API_KEY is too long");
      const sessionId = required(this.sessionId, "OPENWA_SESSION_ID");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
        throw new Error("OPENWA_SESSION_ID is invalid");
      }
    } else {
      this.baseUrl = configuredBaseUrl;
    }
  }

  send(message: OutgoingMessage): Promise<{
    externalId: string;
    simulated?: boolean;
  }> {
    if (!message.idempotencyKey.trim() || message.idempotencyKey.length > 128) {
      throw new Error("OpenWA idempotencyKey must contain 1 to 128 characters");
    }
    const requestFingerprint = fingerprint(message);
    const existing = this.messages.get(message.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        return Promise.reject(
          new Error("OpenWA idempotency key was reused for different content"),
        );
      }
      return existing.result;
    }
    this.validateNewMessage(message);
    if (this.messages.size >= this.maxIdempotencyEntries) {
      throw new Error("OpenWA idempotency capacity is exhausted");
    }
    const result = this.performSend(message);
    // Retain failures because a timeout can occur after WhatsApp accepted the
    // message. Blind retries could otherwise duplicate a real send.
    this.messages.set(message.idempotencyKey, {
      fingerprint: requestFingerprint,
      result,
    });
    return result;
  }

  private validateNewMessage(message: OutgoingMessage): void {
    if (!E164.test(message.to)) throw new Error("OpenWA recipient must use E.164 format");
    if (this.allowedRecipient !== undefined && message.to !== this.allowedRecipient) {
      throw new Error("OpenWA recipient is not allowed by this deployment");
    }
    if (!message.body.trim()) throw new Error("OpenWA message body must not be empty");
    if (message.attachments.length > 1) {
      throw new Error("OpenWA follow-ups support at most one PDF attachment");
    }
    if (!this.dryRun && message.consent !== "EXPLICIT_WHATSAPP_OPT_IN") {
      throw new Error("Live OpenWA requires recorded explicit WhatsApp consent");
    }
    if (!this.dryRun) {
      for (const attachment of message.attachments) {
        let url: URL;
        try {
          url = new URL(attachment);
        } catch {
          throw new Error("Live OpenWA links must be public credential-free HTTPS URLs");
        }
        if (url.protocol !== "https:" || url.username || url.password) {
          throw new Error("Live OpenWA documents must use public credential-free HTTPS URLs");
        }
        if (!PDF_PATH.test(url.pathname)) {
          throw new Error("Live OpenWA attachments must be PDF documents");
        }
      }
    }
    const bodyLimit = message.attachments.length === 0 ? 4_096 : 1_024;
    if (message.body.trim().length > bodyLimit) {
      throw new Error(`OpenWA message exceeds the ${bodyLimit}-character provider limit`);
    }
  }

  private async performSend(
    message: OutgoingMessage,
  ): Promise<{ externalId: string; simulated?: boolean }> {
    const recipientRef = safeReference(message.to);
    if (this.dryRun) {
      const externalId = `openwa.dryrun.${safeReference(message.idempotencyKey)}`;
      this.logger.info("whatsapp.simulated", {
        provider: "openwa",
        recipientRef,
        messageRef: safeReference(externalId),
      });
      return { externalId, simulated: true };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.logger.info("whatsapp.requested", { provider: "openwa", recipientRef });
    try {
      const sessionId = required(this.sessionId, "OPENWA_SESSION_ID");
      const baseUrl = required(this.baseUrl, "OPENWA_BASE_URL");
      const apiKey = required(this.apiKey, "OPENWA_API_KEY");
      const digits = message.to.slice(1);
      const checkResponse = await this.fetchFn(
        `${baseUrl}/api/sessions/${encodeURIComponent(
          sessionId,
        )}/contacts/check/${encodeURIComponent(digits)}`,
        {
          method: "GET",
          headers: { "X-API-Key": apiKey },
          signal: controller.signal,
        },
      );
      const checkPayload = record(await checkResponse.json().catch(() => undefined));
      if (!checkResponse.ok) {
        this.logger.warn("whatsapp.recipient_check_rejected", {
          provider: "openwa",
          httpStatus: checkResponse.status,
          recipientRef,
        });
        throw new Error(
          `OpenWA recipient check was rejected with HTTP ${checkResponse.status}`,
        );
      }
      if (checkPayload?.exists !== true) {
        throw new Error("OpenWA recipient is not registered on WhatsApp");
      }
      const chatId = checkPayload.whatsappId;
      if (
        typeof chatId !== "string" ||
        !/^[1-9]\d{7,19}@(c\.us|lid)$/.test(chatId)
      ) {
        throw new Error("OpenWA recipient check returned an invalid WhatsApp ID");
      }
      const attachment = message.attachments[0];
      const route = attachment === undefined ? "send-text" : "send-document";
      const requestBody = attachment === undefined
        ? {
            chatId: `${digits}@c.us`,
            text: message.body.trim(),
          }
        : {
            chatId: `${digits}@c.us`,
            url: attachment,
            filename: documentFilename(attachment),
            mimetype: "application/pdf",
            caption: message.body.trim(),
          };
      const response = await this.fetchFn(
        `${baseUrl}/api/sessions/${encodeURIComponent(
          sessionId,
        )}/messages/${route}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": apiKey,
          },
          // Send the neutral phone WID. OpenWA resolves it to a privacy LID
          // when necessary. A resume is sent as a native document, with the
          // human follow-up as its caption, so the URL is never shown in chat.
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        },
      );
      const payload = record(await response.json().catch(() => undefined));
      if (!response.ok) {
        const providerCode = typeof payload?.code === "string" &&
          /^[A-Z0-9_]{1,64}$/.test(payload.code)
          ? payload.code
          : undefined;
        this.logger.warn("whatsapp.rejected", {
          provider: "openwa",
          httpStatus: response.status,
          ...(providerCode === undefined ? {} : { providerCode }),
          recipientRef,
        });
        throw new Error(
          `OpenWA request was rejected with HTTP ${response.status}${
            providerCode === undefined ? "" : ` (code ${providerCode})`
          }`,
        );
      }
      const externalId = payload?.messageId;
      if (typeof externalId !== "string" || !externalId.trim()) {
        throw new Error("OpenWA response did not contain a messageId");
      }
      this.logger.info("whatsapp.accepted", {
        provider: "openwa",
        recipientRef,
        messageRef: safeReference(externalId),
      });
      return { externalId, simulated: false };
    } catch (error) {
      if (controller.signal.aborted) {
        this.logger.error("whatsapp.ambiguous_timeout", {
          provider: "openwa",
          recipientRef,
        });
        throw new Error(
          `OpenWA timed out after ${this.timeoutMs} ms; it was not retried because acceptance is unknown`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

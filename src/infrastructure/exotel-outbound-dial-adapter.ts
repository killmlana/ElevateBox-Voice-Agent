import { createHash } from "node:crypto";

import type {
  OutboundDialAdapter,
  OutboundDialRequest,
  OutboundDialResult,
  ReadySingleUseMedia,
} from "../contracts.ts";
import {
  NoopSanitizedLogger,
  safeReference,
  type SanitizedLogger,
} from "./sanitized-logger.ts";

const E164 = /^\+[1-9]\d{7,14}$/;
const LIVE_BASE_URLS = new Set([
  "https://api.in.exotel.com",
  "https://api.exotel.com",
]);
const EXOTEL_CALL_STATUSES = new Set([
  "queued",
  "in-progress",
  "completed",
  "failed",
  "busy",
  "no-answer",
]);

export interface ExotelOutboundDialConfig {
  accountSid?: string;
  apiKey?: string;
  apiToken?: string;
  callerId?: string;
  baseUrl?: string;
  dryRun?: boolean;
  allowPaidCalls?: boolean;
  timeoutMs?: number;
  timeLimitSeconds?: number;
  logger?: SanitizedLogger;
  now?: () => number;
  maxIdempotencyEntries?: number;
}

interface IdempotentDial {
  fingerprint: string;
  result: Promise<OutboundDialResult>;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required for live Exotel dialing`);
  return value.trim();
}

function boundedTimeLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 14_400) {
    throw new Error("Exotel timeLimitSeconds must be an integer from 1 to 14400");
  }
  return value;
}

function responseRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requestFingerprint(request: OutboundDialRequest): string {
  const media = exotelMedia(request);
  return createHash("sha256").update(JSON.stringify({
    token: media.token,
    callId: media.callId,
    streamUrl: media.streamUrl,
    expiresAt: media.expiresAt,
    to: request.to,
    timeLimitSeconds: request.timeLimitSeconds ?? null,
  })).digest("hex");
}

function exotelMedia(request: OutboundDialRequest): ReadySingleUseMedia {
  if (!("streamUrl" in request.media)) {
    throw new Error("Exotel dialing requires an internal prepared media URL");
  }
  if (request.media.provider !== undefined && request.media.provider !== "exotel") {
    throw new Error("Exotel cannot dial a capability prepared for another provider");
  }
  return request.media;
}

/**
 * Exotel's direct AgentStream outbound boundary. It deliberately performs no
 * automatic retries: after a transport timeout the provider may already have
 * accepted a paid call, so retrying could double-dial the lead.
 */
export class ExotelOutboundDialAdapter implements OutboundDialAdapter {
  private readonly dryRun: boolean;
  private readonly allowPaidCalls: boolean;
  private readonly accountSid: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly apiToken: string | undefined;
  private readonly callerId: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly timeLimitSeconds: number;
  private readonly logger: SanitizedLogger;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly maxIdempotencyEntries: number;
  private readonly requests = new Map<string, IdempotentDial>();

  constructor(
    config: ExotelOutboundDialConfig = {},
    fetchFn: typeof fetch = fetch,
  ) {
    this.dryRun = config.dryRun ?? true;
    this.allowPaidCalls = config.allowPaidCalls ?? false;
    this.accountSid = config.accountSid?.trim();
    this.apiKey = config.apiKey?.trim();
    this.apiToken = config.apiToken?.trim();
    this.callerId = config.callerId?.trim();
    this.baseUrl = (config.baseUrl ?? "https://api.in.exotel.com").replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? 8_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 500 || this.timeoutMs > 60_000) {
      throw new Error("Exotel timeoutMs must be an integer from 500 to 60000");
    }
    this.timeLimitSeconds = boundedTimeLimit(config.timeLimitSeconds ?? 600);
    this.logger = config.logger ?? new NoopSanitizedLogger();
    this.now = config.now ?? Date.now;
    this.fetchFn = fetchFn;
    this.maxIdempotencyEntries = config.maxIdempotencyEntries ?? 10_000;
    if (!Number.isInteger(this.maxIdempotencyEntries) || this.maxIdempotencyEntries < 1) {
      throw new Error("Exotel maxIdempotencyEntries must be a positive integer");
    }

    if (!this.dryRun) {
      if (!this.allowPaidCalls) {
        throw new Error(
          "Live Exotel dialing requires an explicit allowPaidCalls acknowledgement",
        );
      }
      required(this.accountSid, "EXOTEL_ACCOUNT_SID");
      required(this.apiKey, "EXOTEL_API_KEY");
      required(this.apiToken, "EXOTEL_API_TOKEN");
      const callerId = required(this.callerId, "EXOTEL_CALLER_ID");
      if (!/^\+?\d{8,15}$/.test(callerId)) {
        throw new Error("EXOTEL_CALLER_ID must be a valid Exophone number");
      }
      if (!LIVE_BASE_URLS.has(this.baseUrl)) {
        throw new Error("Live Exotel base URL must be an official regional HTTPS endpoint");
      }
    }
  }

  dial(request: OutboundDialRequest): Promise<OutboundDialResult> {
    if (!request.idempotencyKey.trim() || request.idempotencyKey.length > 128) {
      throw new Error("Outbound dial idempotencyKey must contain 1 to 128 characters");
    }
    const fingerprint = requestFingerprint(request);
    const existing = this.requests.get(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(
          new Error("Outbound dial idempotency key was reused for a different request"),
        );
      }
      return existing.result;
    }
    this.validateNewRequest(request);
    if (this.requests.size >= this.maxIdempotencyEntries) {
      throw new Error(
        "Outbound dial idempotency capacity is exhausted; reconcile provider state before restart",
      );
    }

    const result = this.performDial(request);
    // Retain both successes and failures. A failed HTTP response is safe to
    // submit under a new key after another prepare; an ambiguous network
    // failure must never be retried automatically under the same key.
    this.requests.set(request.idempotencyKey, { fingerprint, result });
    return result;
  }

  private validateNewRequest(request: OutboundDialRequest): void {
    const media = exotelMedia(request);
    if (media.ready !== true) {
      throw new Error("Outbound dialing requires READY single-use media");
    }
    if (!media.callId.trim() || !media.token.trim()) {
      throw new Error("Prepared media identity is incomplete");
    }
    if (!E164.test(request.to)) throw new Error("Outbound destination must use E.164 format");
    const streamUrl = new URL(media.streamUrl);
    if (media.streamUrl.length > 600) {
      throw new Error("Prepared media URL exceeds Exotel's 600-character limit");
    }
    if (streamUrl.username || streamUrl.password) {
      throw new Error("Prepared media URL must not contain embedded credentials");
    }
    if (!this.dryRun && streamUrl.protocol !== "wss:") {
      throw new Error("Live Exotel media URL must use wss://");
    }
    if (this.dryRun && !["ws:", "wss:"].includes(streamUrl.protocol)) {
      throw new Error("Prepared media URL must use ws:// or wss://");
    }
    const expiresAtMs = Date.parse(media.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
      throw new Error("Prepared media expired before outbound dial");
    }
    if (request.timeLimitSeconds !== undefined) {
      boundedTimeLimit(request.timeLimitSeconds);
    }
  }

  private async performDial(
    request: OutboundDialRequest,
  ): Promise<OutboundDialResult> {
    const media = exotelMedia(request);
    const callRef = safeReference(media.callId);
    const destinationRef = safeReference(request.to);
    if (this.dryRun) {
      const providerCallId = `dryrun_${safeReference(request.idempotencyKey)}`;
      this.logger.info("outbound_dial.simulated", {
        callRef,
        destinationRef,
        providerCallRef: safeReference(providerCallId),
      });
      return { providerCallId, status: "simulated", simulated: true };
    }

    this.logger.info("outbound_dial.requested", { callRef, destinationRef });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const form = new FormData();
      form.set("from", request.to);
      form.set("callerid", required(this.callerId, "EXOTEL_CALLER_ID"));
      form.set("streamurl", media.streamUrl);
      form.set("streamtype", "bidirectional");
      form.set("record", "false");
      form.set(
        "timelimit",
        String(request.timeLimitSeconds ?? this.timeLimitSeconds),
      );
      form.set("customfield", media.callId.slice(0, 128));

      const response = await this.fetchFn(
        `${this.baseUrl}/v1/accounts/${encodeURIComponent(required(
          this.accountSid,
          "EXOTEL_ACCOUNT_SID",
        ))}/calls/connect`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${required(this.apiKey, "EXOTEL_API_KEY")}:${required(
                this.apiToken,
                "EXOTEL_API_TOKEN",
              )}`,
            ).toString("base64")}`,
          },
          body: form,
          signal: controller.signal,
        },
      );
      const requestId = response.headers.get("x-request-id") ?? undefined;
      if (!response.ok) {
        this.logger.warn("outbound_dial.rejected", {
          callRef,
          httpStatus: response.status,
          ...(requestId ? { providerRequestRef: safeReference(requestId) } : {}),
        });
        throw new Error(
          `Exotel outbound dial was rejected with HTTP ${response.status}${
            requestId ? ` (request ${safeReference(requestId)})` : ""
          }`,
        );
      }
      const root = responseRecord(await response.json());
      const call = responseRecord(root?.call ?? root?.Call);
      const providerCallId = call?.sid ?? call?.Sid;
      const status = call?.status ?? call?.Status;
      if (
        typeof providerCallId !== "string" ||
        typeof status !== "string" ||
        !EXOTEL_CALL_STATUSES.has(status)
      ) {
        throw new Error("Exotel outbound dial response did not contain call identity");
      }
      this.logger.info("outbound_dial.accepted", {
        callRef,
        providerCallRef: safeReference(providerCallId),
        providerStatus: status,
      });
      return { providerCallId, status, simulated: false };
    } catch (error) {
      if (controller.signal.aborted) {
        this.logger.error("outbound_dial.ambiguous_timeout", { callRef });
        throw new Error(
          `Exotel outbound dial timed out after ${this.timeoutMs} ms; it was not retried because provider acceptance is unknown`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

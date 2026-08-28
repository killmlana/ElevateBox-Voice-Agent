import { createHash, createHmac } from "node:crypto";

import type { CallbackBooking, SchedulerAdapter } from "../contracts.ts";
import {
  NoopSanitizedLogger,
  safeReference,
  type SanitizedLogger,
} from "./sanitized-logger.ts";

const E164 = /^\+[1-9]\d{7,14}$/;

export interface WebhookCallbackSchedulerConfig {
  dryRun?: boolean;
  allowLiveBookings?: boolean;
  webhookUrl?: string;
  signingSecret?: string;
  allowedLeadPhone?: string;
  timeoutMs?: number;
  maxIdempotencyEntries?: number;
  logger?: SanitizedLogger;
  now?: () => number;
}

interface RememberedBooking {
  fingerprint: string;
  result: Promise<{ externalId: string; simulated?: boolean }>;
}

function fingerprint(booking: CallbackBooking): string {
  return createHash("sha256").update(JSON.stringify({
    leadPhone: booking.leadPhone,
    scheduledAt: booking.scheduledAt,
    rawTime: booking.rawTime,
  })).digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Provider-neutral booking adapter for a CRM, calendar, or job scheduler.
 * The exact JSON body is HMAC signed and carries an Idempotency-Key header.
 */
export class WebhookCallbackSchedulerAdapter implements SchedulerAdapter {
  private readonly dryRun: boolean;
  private readonly allowLiveBookings: boolean;
  private readonly webhookUrl: URL | undefined;
  private readonly signingSecret: string | undefined;
  private readonly allowedLeadPhone: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxIdempotencyEntries: number;
  private readonly logger: SanitizedLogger;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly bookings = new Map<string, RememberedBooking>();

  constructor(
    config: WebhookCallbackSchedulerConfig = {},
    fetchFn: typeof fetch = fetch,
  ) {
    this.dryRun = config.dryRun ?? true;
    this.allowLiveBookings = config.allowLiveBookings ?? false;
    this.webhookUrl = config.webhookUrl ? new URL(config.webhookUrl) : undefined;
    this.signingSecret = config.signingSecret?.trim();
    this.allowedLeadPhone = config.allowedLeadPhone?.trim();
    this.timeoutMs = config.timeoutMs ?? 8_000;
    this.maxIdempotencyEntries = config.maxIdempotencyEntries ?? 10_000;
    this.logger = config.logger ?? new NoopSanitizedLogger();
    this.now = config.now ?? Date.now;
    this.fetchFn = fetchFn;

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 500 || this.timeoutMs > 60_000) {
      throw new Error("Callback timeoutMs must be an integer from 500 to 60000");
    }
    if (!Number.isInteger(this.maxIdempotencyEntries) || this.maxIdempotencyEntries < 1) {
      throw new Error("Callback maxIdempotencyEntries must be a positive integer");
    }
    if (this.allowedLeadPhone !== undefined && !E164.test(this.allowedLeadPhone)) {
      throw new Error("Callback allowedLeadPhone must use E.164 format");
    }
    if (!this.dryRun) {
      if (!this.allowLiveBookings) {
        throw new Error(
          "Live callback booking requires an explicit allowLiveBookings acknowledgement",
        );
      }
      if (
        !this.webhookUrl ||
        this.webhookUrl.protocol !== "https:" ||
        this.webhookUrl.username ||
        this.webhookUrl.password
      ) {
        throw new Error("CALLBACK_WEBHOOK_URL must be credential-free HTTPS");
      }
      if (!this.signingSecret || this.signingSecret.length < 16) {
        throw new Error("CALLBACK_WEBHOOK_SECRET must contain at least 16 characters");
      }
    }
  }

  book(booking: CallbackBooking): Promise<{
    externalId: string;
    simulated?: boolean;
  }> {
    if (!booking.idempotencyKey.trim() || booking.idempotencyKey.length > 128) {
      throw new Error("Callback idempotencyKey must contain 1 to 128 characters");
    }
    const bookingFingerprint = fingerprint(booking);
    const existing = this.bookings.get(booking.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== bookingFingerprint) {
        return Promise.reject(
          new Error("Callback idempotency key was reused for a different booking"),
        );
      }
      return existing.result;
    }
    this.validateNewBooking(booking);
    if (this.bookings.size >= this.maxIdempotencyEntries) {
      throw new Error("Callback idempotency capacity is exhausted");
    }
    const result = this.performBooking(booking);
    this.bookings.set(booking.idempotencyKey, {
      fingerprint: bookingFingerprint,
      result,
    });
    return result;
  }

  private validateNewBooking(booking: CallbackBooking): void {
    if (!E164.test(booking.leadPhone)) {
      throw new Error("Callback lead phone must use E.164 format");
    }
    if (
      this.allowedLeadPhone !== undefined &&
      booking.leadPhone !== this.allowedLeadPhone
    ) {
      throw new Error("Callback lead phone is not allowed by this deployment");
    }
    if (!booking.rawTime.trim() || booking.rawTime.length > 256) {
      throw new Error("Callback rawTime must contain 1 to 256 characters");
    }
    const scheduledAtMs = Date.parse(booking.scheduledAt);
    if (!Number.isFinite(scheduledAtMs) || scheduledAtMs <= this.now()) {
      throw new Error("Callback scheduledAt must be a future ISO timestamp");
    }
  }

  private async performBooking(
    booking: CallbackBooking,
  ): Promise<{ externalId: string; simulated?: boolean }> {
    const leadRef = safeReference(booking.leadPhone);
    const scheduleRef = safeReference(booking.scheduledAt);
    if (this.dryRun) {
      const externalId = `callback.dryrun.${safeReference(booking.idempotencyKey)}`;
      this.logger.info("callback.simulated", {
        leadRef,
        scheduleRef,
        bookingRef: safeReference(externalId),
      });
      return { externalId, simulated: true };
    }

    const body = JSON.stringify({
      type: "callback.requested",
      leadPhone: booking.leadPhone,
      scheduledAt: booking.scheduledAt,
      rawTime: booking.rawTime,
      idempotencyKey: booking.idempotencyKey,
      timezone: "Asia/Kolkata",
    });
    const signature = createHmac(
      "sha256",
      this.signingSecret!,
    ).update(body).digest("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.logger.info("callback.requested", { leadRef, scheduleRef });
    try {
      const response = await this.fetchFn(this.webhookUrl!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": booking.idempotencyKey,
          "X-ElevateBox-Signature": `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn("callback.rejected", {
          leadRef,
          scheduleRef,
          httpStatus: response.status,
        });
        throw new Error(
          `Callback webhook rejected the booking with HTTP ${response.status}`,
        );
      }
      const payload = record(await response.json().catch(() => undefined));
      const externalId = payload?.id;
      if (typeof externalId !== "string" || !externalId.trim()) {
        throw new Error("Callback webhook response did not contain a booking ID");
      }
      this.logger.info("callback.accepted", {
        leadRef,
        scheduleRef,
        bookingRef: safeReference(externalId),
      });
      return { externalId, simulated: false };
    } catch (error) {
      if (controller.signal.aborted) {
        this.logger.error("callback.ambiguous_timeout", { leadRef, scheduleRef });
        throw new Error(
          `Callback webhook timed out after ${this.timeoutMs} ms; it was not retried because acceptance is unknown`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

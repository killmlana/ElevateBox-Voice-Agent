import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { CallbackBooking, SchedulerAdapter } from "../contracts.ts";
import {
  NoopSanitizedLogger,
  safeReference,
  type SanitizedLogger,
} from "./sanitized-logger.ts";

type CallbackStatus = "scheduled" | "dialing" | "completed" | "failed" | "missed";

interface CallbackRecord extends CallbackBooking {
  id: string;
  status: CallbackStatus;
  createdAt: string;
  updatedAt: string;
  errorRef?: string;
}

export interface DurableSipCallbackSchedulerOptions {
  statePath: string;
  recoveryGraceMs?: number;
  now?: () => Date;
  logger?: SanitizedLogger;
}

export type ScheduledCallbackExecutor = (booking: CallbackBooking) => Promise<void>;

const MAX_TIMER_MS = 2_147_000_000;
const E164 = /^\+[1-9]\d{7,14}$/;

/** Persistent, at-most-once automatic callback scheduler for the local SIP dialer. */
export class DurableSipCallbackScheduler implements SchedulerAdapter {
  private readonly statePath: string;
  private readonly recoveryGraceMs: number;
  private readonly now: () => Date;
  private readonly logger: SanitizedLogger;
  private readonly records = new Map<string, CallbackRecord>();
  private executor: ScheduledCallbackExecutor | undefined;
  private timer: NodeJS.Timeout | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private started = false;
  private closed = false;

  constructor(options: DurableSipCallbackSchedulerOptions) {
    if (!options.statePath.trim()) throw new Error("Callback state path is required");
    this.statePath = options.statePath;
    this.recoveryGraceMs = options.recoveryGraceMs ?? 15 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? new NoopSanitizedLogger();
  }

  setExecutor(executor: ScheduledCallbackExecutor): void {
    this.executor = executor;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.executor) throw new Error("Automatic callback executor is not configured");
    this.started = true;
    await mkdir(dirname(this.statePath), { recursive: true });
    let serialized: string | undefined;
    try {
      serialized = await readFile(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (serialized?.trim()) {
      const parsed = JSON.parse(serialized) as unknown;
      if (!Array.isArray(parsed)) throw new Error("Callback state file must contain an array");
      for (const item of parsed) {
        if (!this.isRecord(item)) throw new Error("Callback state file is invalid");
        this.records.set(item.idempotencyKey, item);
      }
    }
    const nowMs = this.now().getTime();
    let changed = false;
    for (const record of this.records.values()) {
      if (record.status === "dialing") {
        record.status = "failed";
        record.updatedAt = this.now().toISOString();
        record.errorRef = safeReference("process restarted during callback dial");
        changed = true;
      } else if (
        record.status === "scheduled" &&
        new Date(record.scheduledAt).getTime() < nowMs - this.recoveryGraceMs
      ) {
        record.status = "missed";
        record.updatedAt = this.now().toISOString();
        changed = true;
      }
    }
    if (changed) await this.persist();
    this.arm();
    this.logger.info("callback.scheduler_started", {
      scheduledCount: [...this.records.values()].filter((item) => item.status === "scheduled").length,
    });
  }

  async book(booking: CallbackBooking): Promise<{ externalId: string }> {
    return this.serial(async () => {
      if (!this.started || this.closed) throw new Error("Callback scheduler is not running");
      const existing = this.records.get(booking.idempotencyKey);
      if (existing) {
        if (
          existing.leadPhone !== booking.leadPhone ||
          existing.scheduledAt !== booking.scheduledAt ||
          existing.rawTime !== booking.rawTime ||
          existing.preferredLanguage !== booking.preferredLanguage
        ) {
          throw new Error("Callback idempotency key was reused for a different booking");
        }
        return { externalId: existing.id };
      }
      if (!booking.idempotencyKey.trim() || booking.idempotencyKey.length > 128) {
        throw new Error("Callback idempotencyKey must contain 1 to 128 characters");
      }
      if (!E164.test(booking.leadPhone)) {
        throw new Error("Callback lead phone must use E.164 format");
      }
      if (!booking.rawTime.trim() || booking.rawTime.length > 256) {
        throw new Error("Callback rawTime must contain 1 to 256 characters");
      }
      const scheduledAtMs = new Date(booking.scheduledAt).getTime();
      if (!Number.isFinite(scheduledAtMs)) throw new Error("Callback time is invalid");
      if (scheduledAtMs <= this.now().getTime()) {
        throw new Error("Callback time must be in the future");
      }
      const timestamp = this.now().toISOString();
      const id = `sipcb_${createHash("sha256").update(booking.idempotencyKey).digest("hex").slice(0, 16)}`;
      this.records.set(booking.idempotencyKey, {
        ...booking,
        id,
        status: "scheduled",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.persist();
      this.arm();
      this.logger.info("callback.scheduled", {
        callbackRef: safeReference(id),
        scheduledAt: booking.scheduledAt,
        language: booking.preferredLanguage ?? "UNKNOWN",
      });
      return { externalId: id };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.mutationTail;
  }

  private arm(): void {
    if (!this.started || this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    const next = [...this.records.values()]
      .filter((item) => item.status === "scheduled")
      .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt))[0];
    if (!next) return;
    const delay = Math.max(0, new Date(next.scheduledAt).getTime() - this.now().getTime());
    this.timer = setTimeout(() => void this.runDue(), Math.min(delay, MAX_TIMER_MS));
    this.timer.unref();
  }

  private async runDue(): Promise<void> {
    await this.serial(async () => {
      const nowMs = this.now().getTime();
      const due = [...this.records.values()]
        .filter((item) => item.status === "scheduled" && new Date(item.scheduledAt).getTime() <= nowMs)
        .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
      for (const record of due) {
        record.status = "dialing";
        record.updatedAt = this.now().toISOString();
        await this.persist();
        this.logger.info("callback.auto_dial_started", {
          callbackRef: safeReference(record.id),
          scheduledAt: record.scheduledAt,
        });
        try {
          await this.executor!({
            leadPhone: record.leadPhone,
            scheduledAt: record.scheduledAt,
            rawTime: record.rawTime,
            idempotencyKey: record.idempotencyKey,
            ...(record.preferredLanguage
              ? { preferredLanguage: record.preferredLanguage }
              : {}),
          });
          record.status = "completed";
          this.logger.info("callback.auto_dial_completed", {
            callbackRef: safeReference(record.id),
          });
        } catch (error) {
          record.status = "failed";
          record.errorRef = safeReference(error instanceof Error ? error.message : String(error));
          this.logger.error("callback.auto_dial_failed", {
            callbackRef: safeReference(record.id),
            errorRef: record.errorRef,
          });
        }
        record.updatedAt = this.now().toISOString();
        await this.persist();
      }
    });
    this.arm();
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(): Promise<void> {
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify([...this.records.values()], null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.statePath);
  }

  private isRecord(value: unknown): value is CallbackRecord {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<CallbackRecord>;
    return typeof item.id === "string" &&
      typeof item.idempotencyKey === "string" &&
      typeof item.leadPhone === "string" &&
      typeof item.scheduledAt === "string" &&
      typeof item.rawTime === "string" &&
      ["scheduled", "dialing", "completed", "failed", "missed"].includes(item.status ?? "") &&
      typeof item.createdAt === "string" &&
      typeof item.updatedAt === "string";
  }
}

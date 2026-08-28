import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import type { CallbackBooking } from "../src/contracts.ts";
import type {
  SafeLogValue,
  SanitizedLogger,
} from "../src/infrastructure/sanitized-logger.ts";
import { WebhookCallbackSchedulerAdapter } from "../src/infrastructure/webhook-callback-scheduler-adapter.ts";

class CapturingLogger implements SanitizedLogger {
  readonly entries: unknown[] = [];
  info(event: string, fields?: Readonly<Record<string, SafeLogValue>>): void {
    this.entries.push({ event, fields });
  }
  warn(event: string, fields?: Readonly<Record<string, SafeLogValue>>): void {
    this.entries.push({ event, fields });
  }
  error(event: string, fields?: Readonly<Record<string, SafeLogValue>>): void {
    this.entries.push({ event, fields });
  }
}

function booking(overrides: Partial<CallbackBooking> = {}): CallbackBooking {
  return {
    leadPhone: "+919876543210",
    scheduledAt: "2026-08-27T04:30:00.000Z",
    rawTime: "tomorrow at 10 am",
    idempotencyKey: "callback-call-1-once",
    ...overrides,
  };
}

test("callback scheduler defaults to a sanitized no-network dry run", async () => {
  let fetchCount = 0;
  const logger = new CapturingLogger();
  const adapter = new WebhookCallbackSchedulerAdapter(
    {
      logger,
      now: () => Date.parse("2026-08-26T10:00:00.000Z"),
    },
    (async () => {
      fetchCount += 1;
      throw new Error("dry run must not call a webhook");
    }) as typeof fetch,
  );
  const first = adapter.book(booking());
  const replay = adapter.book(booking());
  assert.strictEqual(first, replay);
  assert.match((await first).externalId, /^callback\.dryrun\./);
  assert.equal(fetchCount, 0);
  const logs = JSON.stringify(logger.entries);
  assert.doesNotMatch(logs, /\+919876543210/);
  assert.doesNotMatch(logs, /2026-08-27T04:30/);
  assert.doesNotMatch(logs, /callback-call-1-once/);
});

test("posts the signed callback booking contract idempotently", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const signingSecret = "callback-signing-secret-long";
  const adapter = new WebhookCallbackSchedulerAdapter(
    {
      dryRun: false,
      allowLiveBookings: true,
      webhookUrl: "https://scheduler.example.com/elevatebox/callbacks",
      signingSecret,
      allowedLeadPhone: "+919876543210",
      now: () => Date.parse("2026-08-26T10:00:00.000Z"),
    },
    (async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ id: "scheduler-booking-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  );

  assert.deepEqual(await adapter.book(booking()), {
    externalId: "scheduler-booking-1",
    simulated: false,
  });
  assert.equal(
    capturedUrl,
    "https://scheduler.example.com/elevatebox/callbacks",
  );
  const body = String(capturedInit?.body);
  assert.deepEqual(JSON.parse(body), {
    type: "callback.requested",
    leadPhone: "+919876543210",
    scheduledAt: "2026-08-27T04:30:00.000Z",
    rawTime: "tomorrow at 10 am",
    idempotencyKey: "callback-call-1-once",
    timezone: "Asia/Kolkata",
  });
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers["Idempotency-Key"], "callback-call-1-once");
  assert.equal(
    headers["X-ElevateBox-Signature"],
    `sha256=${createHmac("sha256", signingSecret).update(body).digest("hex")}`,
  );
});

test("callback failures are cached and response bodies stay out of errors/logs", async () => {
  let fetchCount = 0;
  const logger = new CapturingLogger();
  const adapter = new WebhookCallbackSchedulerAdapter(
    {
      dryRun: false,
      allowLiveBookings: true,
      webhookUrl: "https://scheduler.example.com/callbacks",
      signingSecret: "callback-signing-secret-long",
      allowedLeadPhone: "+919876543210",
      logger,
      now: () => Date.parse("2026-08-26T10:00:00.000Z"),
    },
    (async () => {
      fetchCount += 1;
      return new Response("sensitive +919876543210 response", { status: 503 });
    }) as typeof fetch,
  );
  await assert.rejects(adapter.book(booking()), /HTTP 503/);
  await assert.rejects(adapter.book(booking()), /HTTP 503/);
  assert.equal(fetchCount, 1);
  const logs = JSON.stringify(logger.entries);
  assert.doesNotMatch(logs, /\+919876543210/);
  assert.doesNotMatch(logs, /sensitive/);
});

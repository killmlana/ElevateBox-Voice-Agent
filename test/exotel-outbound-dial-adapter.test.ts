import assert from "node:assert/strict";
import test from "node:test";

import type { OutboundDialRequest } from "../src/contracts.ts";
import { ExotelOutboundDialAdapter } from "../src/infrastructure/exotel-outbound-dial-adapter.ts";
import type {
  SafeLogValue,
  SanitizedLogger,
} from "../src/infrastructure/sanitized-logger.ts";

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

function request(overrides: Partial<OutboundDialRequest> = {}): OutboundDialRequest {
  return {
    media: {
      ready: true,
      callId: "lead-call-sensitive",
      token: "single-use-secret-token",
      streamUrl:
        "wss://voice.example.com/media/single-use-secret-token?sample-rate=24000",
      expiresAt: "2026-08-26T11:00:00.000Z",
    },
    to: "+919876543210",
    idempotencyKey: "dial-once-sensitive-key",
    ...overrides,
  };
}

test("defaults to a sanitized, idempotent dry run without touching fetch", async () => {
  let fetchCount = 0;
  const logger = new CapturingLogger();
  const adapter = new ExotelOutboundDialAdapter(
    {
      logger,
      now: () => Date.parse("2026-08-26T10:00:00.000Z"),
    },
    (async () => {
      fetchCount += 1;
      throw new Error("fetch must not run in dry-run mode");
    }) as typeof fetch,
  );

  const first = adapter.dial(request());
  const second = adapter.dial(request());
  assert.strictEqual(first, second, "same key shares the same provider operation");
  const result = await first;
  assert.equal(result.simulated, true);
  assert.equal(fetchCount, 0);

  const logText = JSON.stringify(logger.entries);
  assert.doesNotMatch(logText, /\+919876543210/);
  assert.doesNotMatch(logText, /single-use-secret-token/);
  assert.doesNotMatch(logText, /dial-once-sensitive-key/);
  assert.doesNotMatch(logText, /voice\.example\.com/);
});

test("matches Exotel direct AgentStream outbound request and response contract", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const adapter = new ExotelOutboundDialAdapter(
    {
      dryRun: false,
      allowPaidCalls: true,
      accountSid: "account-1",
      apiKey: "api-key-secret",
      apiToken: "api-token-secret",
      callerId: "08047491899",
      baseUrl: "https://api.in.exotel.com",
      timeLimitSeconds: 300,
      now: () => Date.parse("2026-08-26T10:00:00.000Z"),
    },
    (async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({
        call: { sid: "provider-call-1", status: "in-progress" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  );

  const result = await adapter.dial(request());
  assert.deepEqual(result, {
    providerCallId: "provider-call-1",
    status: "in-progress",
    simulated: false,
  });
  assert.equal(
    capturedUrl,
    "https://api.in.exotel.com/v1/accounts/account-1/calls/connect",
  );
  assert.equal(capturedInit?.method, "POST");
  assert.equal(
    (capturedInit?.headers as Record<string, string>).Authorization,
    `Basic ${Buffer.from("api-key-secret:api-token-secret").toString("base64")}`,
  );
  const form = capturedInit?.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("from"), "+919876543210");
  assert.equal(form.get("callerid"), "08047491899");
  assert.equal(form.get("streamurl"), request().media.streamUrl);
  assert.equal(form.get("streamtype"), "bidirectional");
  assert.equal(form.get("record"), "false");
  assert.equal(form.get("timelimit"), "300");
  assert.equal(form.get("customfield"), "lead-call-sensitive");
});

test("rejects unready/expired media and idempotency conflicts before fetch", async () => {
  let fetchCount = 0;
  const adapter = new ExotelOutboundDialAdapter(
    { now: () => Date.parse("2026-08-26T10:00:00.000Z") },
    (async () => {
      fetchCount += 1;
      return new Response();
    }) as typeof fetch,
  );
  assert.throws(
    () => adapter.dial(request({
      media: { ...request().media, ready: false as true },
    })),
    /requires READY/,
  );
  assert.throws(
    () => adapter.dial(request({
      media: { ...request().media, expiresAt: "2026-08-26T09:59:59.000Z" },
    })),
    /expired/,
  );
  await adapter.dial(request());
  await assert.rejects(
    adapter.dial(request({ to: "+919111111111" })),
    /idempotency key was reused/,
  );
  assert.equal(fetchCount, 0);
});

test("does not retry or expose an Exotel failure body", async () => {
  let fetchCount = 0;
  const logger = new CapturingLogger();
  const adapter = new ExotelOutboundDialAdapter(
    {
      dryRun: false,
      allowPaidCalls: true,
      accountSid: "account-1",
      apiKey: "api-key-secret",
      apiToken: "api-token-secret",
      callerId: "08047491899",
      logger,
      now: () => Date.parse("2026-08-26T10:00:00.000Z"),
    },
    (async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({ message: "secret provider body +919876543210" }),
        { status: 403, headers: { "x-request-id": "provider-request-secret" } },
      );
    }) as typeof fetch,
  );

  await assert.rejects(adapter.dial(request()), /HTTP 403/);
  await assert.rejects(adapter.dial(request()), /HTTP 403/);
  assert.equal(fetchCount, 1);
  const logs = JSON.stringify(logger.entries);
  assert.doesNotMatch(logs, /secret provider body/);
  assert.doesNotMatch(logs, /\+919876543210/);
  assert.doesNotMatch(logs, /provider-request-secret/);
});

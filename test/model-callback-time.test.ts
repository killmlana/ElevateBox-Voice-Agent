import assert from "node:assert/strict";
import test from "node:test";

import {
  CALLBACK_TIME_SCHEMA,
  LeadPatchCallbackTimeClient,
  ModelCallbackTimeResolver,
  type CallbackTimeClient,
} from "../src/infrastructure/model-callback-time.ts";

const now = new Date("2026-08-28T05:30:00.000Z"); // 11:00 IST, Friday

function clientReturning(
  value: unknown,
  captured?: { input?: Parameters<CallbackTimeClient["generate"]>[0] },
): CallbackTimeClient {
  return {
    async generate(input) {
      if (captured) captured.input = input;
      return value;
    },
  };
}

test("resolves a phrase the deterministic parser cannot handle", async () => {
  const resolver = new ModelCallbackTimeResolver(
    clientReturning({ status: "resolved", resolvedAt: "2026-08-31T12:30:00.000Z" }),
  );

  const resolution = await resolver.resolve({ rawTime: "Monday evening", now });

  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.resolvedAt, "2026-08-31T12:30:00.000Z");
  assert.equal(resolution.rawTime, "Monday evening");
});

test("sends the current time and timezone so relative phrases can be anchored", async () => {
  const captured: { input?: Parameters<CallbackTimeClient["generate"]>[0] } = {};
  const resolver = new ModelCallbackTimeResolver(
    clientReturning({ status: "resolved", resolvedAt: "2026-08-29T12:30:00.000Z" }, captured),
  );

  await resolver.resolve({ rawTime: "kal shaam", now, languageHint: "HI" });

  assert.equal(captured.input?.nowIso, now.toISOString());
  assert.equal(captured.input?.timeZone, "Asia/Kolkata");
  assert.equal(captured.input?.languageHint, "HI");
  assert.equal(captured.input?.rawTime, "kal shaam");
  assert.equal(captured.input?.schema, CALLBACK_TIME_SCHEMA);
  // The model reasons about "tomorrow" against local wall-clock time, not UTC.
  assert.match(captured.input?.nowLocal ?? "", /^2026-08-28 11:00/);
});

test("passes through a model request for clarification", async () => {
  const resolver = new ModelCallbackTimeResolver(
    clientReturning({ status: "needs_clarification", reason: "No day was given." }),
  );

  const resolution = await resolver.resolve({ rawTime: "later", now });

  assert.equal(resolution.status, "needs_clarification");
  assert.equal(resolution.reason, "No day was given.");
  assert.equal(resolution.resolvedAt, undefined);
});

test("falls back to the deterministic parser when the model call fails", async () => {
  const resolver = new ModelCallbackTimeResolver({
    async generate() {
      throw new Error("upstream unavailable");
    },
  });

  const resolution = await resolver.resolve({ rawTime: "tomorrow morning", now });

  // The deterministic parser handles "tomorrow morning" -> 10:00 IST next day.
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.resolvedAt, "2026-08-29T04:30:00.000Z");
});

test("rejects a resolved time in the past and falls back", async () => {
  const resolver = new ModelCallbackTimeResolver(
    clientReturning({ status: "resolved", resolvedAt: "2026-08-27T12:30:00.000Z" }),
  );

  const resolution = await resolver.resolve({ rawTime: "tomorrow morning", now });

  assert.equal(resolution.status, "resolved");
  assert.equal(
    resolution.resolvedAt,
    "2026-08-29T04:30:00.000Z",
    "a past timestamp must be discarded in favour of the deterministic parse",
  );
});

test("rejects an implausibly distant resolved time and falls back", async () => {
  const resolver = new ModelCallbackTimeResolver(
    clientReturning({ status: "resolved", resolvedAt: "2028-01-01T12:30:00.000Z" }),
  );

  const resolution = await resolver.resolve({ rawTime: "tomorrow morning", now });

  assert.equal(resolution.resolvedAt, "2026-08-29T04:30:00.000Z");
});

test("rejects a malformed timestamp and falls back", async () => {
  const resolver = new ModelCallbackTimeResolver(
    clientReturning({ status: "resolved", resolvedAt: "next monday please" }),
  );

  const resolution = await resolver.resolve({ rawTime: "tomorrow morning", now });

  assert.equal(resolution.resolvedAt, "2026-08-29T04:30:00.000Z");
});

test("treats a resolved status with no timestamp as unusable", async () => {
  const resolver = new ModelCallbackTimeResolver(
    clientReturning({ status: "resolved" }),
  );

  // Deterministic parser also cannot resolve this, so clarification is correct.
  const resolution = await resolver.resolve({ rawTime: "sometime", now });

  assert.equal(resolution.status, "needs_clarification");
});

test("does not call the model for an empty phrase", async () => {
  let calls = 0;
  const resolver = new ModelCallbackTimeResolver({
    async generate() {
      calls += 1;
      return { status: "resolved", resolvedAt: "2026-08-29T12:30:00.000Z" };
    },
  });

  const resolution = await resolver.resolve({ rawTime: "   ", now });

  assert.equal(resolution.status, "not_requested");
  assert.equal(calls, 0);
});

test("bridges onto the structured lead-patch client, carrying temporal context", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const resolver = new ModelCallbackTimeResolver(
    new LeadPatchCallbackTimeClient({
      async generate(input) {
        calls.push(input as unknown as Record<string, unknown>);
        return { status: "resolved", resolvedAt: "2026-08-31T12:30:00.000Z" };
      },
    }),
  );

  const resolution = await resolver.resolve({
    rawTime: "Monday evening",
    now,
    languageHint: "EN",
  });

  assert.equal(resolution.resolvedAt, "2026-08-31T12:30:00.000Z");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.schemaName, "callback_time");
  assert.equal(calls[0]?.languageHint, "EN");
  const payload = JSON.parse(String(calls[0]?.turnText)) as Record<string, unknown>;
  assert.equal(payload.callbackPhrase, "Monday evening");
  assert.equal(payload.nowIso, now.toISOString());
  assert.equal(payload.timeZone, "Asia/Kolkata");
  assert.match(String(payload.nowLocal), /^2026-08-28 11:00/);
});

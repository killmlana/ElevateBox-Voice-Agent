import assert from "node:assert/strict";
import test from "node:test";

import { resolveCallbackTime } from "../src/domain/callback-time.ts";

const base = new Date("2026-08-26T10:00:00.000Z");

test("resolves tomorrow morning to 10:00 Asia/Kolkata", () => {
  const result = resolveCallbackTime("tomorrow morning", base);
  assert.equal(result.status, "resolved");
  assert.equal(result.resolvedAt, "2026-08-27T04:30:00.000Z");
});

test("resolves an explicit tomorrow time", () => {
  const result = resolveCallbackTime("tomorrow at 4:30 pm", base);
  assert.equal(result.status, "resolved");
  assert.equal(result.resolvedAt, "2026-08-27T11:00:00.000Z");
});

test("resolves a Hindi tomorrow-evening callback with a spoken hour", () => {
  const result = resolveCallbackTime("हाँ, कल शाम को, छह बजे", base);
  assert.equal(result.status, "resolved");
  assert.equal(result.resolvedAt, "2026-08-27T12:30:00.000Z");
});

test("resolves a Telugu tomorrow-evening callback with a spoken hour", () => {
  const result = resolveCallbackTime("రేపు సాయంత్రం ఆరు గంటలకు", base);
  assert.equal(result.status, "resolved");
  assert.equal(result.resolvedAt, "2026-08-27T12:30:00.000Z");
});

test("requests clarification when a time window is absent", () => {
  const result = resolveCallbackTime("tomorrow", base);
  assert.equal(result.status, "needs_clarification");
  assert.match(result.reason ?? "", /time/i);
});

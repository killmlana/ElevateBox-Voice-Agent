import assert from "node:assert/strict";
import test from "node:test";

import { WebhookRequestError } from "../src/infrastructure/live-gateway-server.ts";
import {
  signOpenAIWebhook,
  VerifiedOpenAIWebhookReceiver,
  type OpenAIIncomingSipWebhook,
} from "../src/infrastructure/openai-webhook-receiver.ts";

const now = 1_777_000_000;
const secret = `whsec_${Buffer.from("openai-webhook-test-key").toString("base64")}`;

function incomingBody(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    id: "evt_realtime_1",
    type: "realtime.call.incoming",
    created_at: now,
    data: {
      call_id: "rtc_call_1",
      sip_headers: [
        { name: "Call-ID", value: "asterisk-call-id-1" },
        { name: "From", value: "<sip:redacted@example.invalid>" },
      ],
    },
    ...overrides,
  }));
}

function headers(body: Buffer, id = "msg_delivery_1", timestamp = now) {
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signOpenAIWebhook(secret, id, timestamp, body),
  };
}

test("verifies the raw OpenAI webhook, preserves SIP Call-ID, and rejects replay", async () => {
  const received: OpenAIIncomingSipWebhook[] = [];
  const receiver = new VerifiedOpenAIWebhookReceiver(
    { secret, now: () => now },
    {
      async handleIncomingCall(event) {
        received.push(event);
      },
    },
  );
  const body = incomingBody();

  assert.equal(await receiver.handle(body, headers(body)), "processed");
  assert.equal(await receiver.handle(body, headers(body)), "duplicate");
  assert.equal(received.length, 1);
  assert.equal(received[0]?.callId, "rtc_call_1");
  assert.deepEqual(received[0]?.sipHeaders[0], {
    name: "Call-ID",
    value: "asterisk-call-id-1",
  });
});

test("rejects unsigned, tampered, stale, and malformed incoming webhooks", async () => {
  const receiver = new VerifiedOpenAIWebhookReceiver(
    { secret, now: () => now, toleranceSeconds: 300 },
    { async handleIncomingCall() {} },
  );
  const body = incomingBody();

  await assert.rejects(
    receiver.handle(body, {}),
    (error: unknown) => error instanceof WebhookRequestError && error.status === 401,
  );
  await assert.rejects(
    receiver.handle(Buffer.concat([body, Buffer.from(" ")]), headers(body, "tampered")),
    /signature is invalid/,
  );
  await assert.rejects(
    receiver.handle(body, headers(body, "stale", now - 301)),
    /outside tolerance/,
  );

  const malformed = Buffer.from("not-json");
  await assert.rejects(
    receiver.handle(malformed, headers(malformed, "malformed")),
    (error: unknown) => error instanceof WebhookRequestError && error.status === 400,
  );
});

test("allows a failed delivery to be retried and ignores other signed event types", async () => {
  let attempts = 0;
  const receiver = new VerifiedOpenAIWebhookReceiver(
    { secret, now: () => now },
    {
      async handleIncomingCall() {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary coordinator failure");
      },
    },
  );
  const body = incomingBody();
  await assert.rejects(receiver.handle(body, headers(body, "retryable")));
  assert.equal(await receiver.handle(body, headers(body, "retryable")), "processed");
  assert.equal(attempts, 2);

  const ignored = incomingBody({ type: "response.completed" });
  assert.equal(await receiver.handle(ignored, headers(ignored, "ignored")), "ignored");
});

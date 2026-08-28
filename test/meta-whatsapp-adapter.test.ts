import assert from "node:assert/strict";
import test from "node:test";

import type { OutgoingMessage } from "../src/contracts.ts";
import { MetaWhatsAppAdapter } from "../src/infrastructure/meta-whatsapp-adapter.ts";
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

function message(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    to: "+919876543210",
    body: "ElevateBox follow-up for the discussed website.",
    attachments: [
      "https://assets.example.com/resume.pdf",
      "https://assets.example.com/architecture.png",
    ],
    idempotencyKey: "whatsapp-call-1-once",
    consent: "EXPLICIT_WHATSAPP_OPT_IN",
    ...overrides,
  };
}

function liveConfig(logger?: SanitizedLogger) {
  return {
    dryRun: false,
    allowRealMessages: true,
    accessToken: "meta-access-token-secret",
    phoneNumberId: "123456789012345",
    graphApiVersion: "v23.0",
    templateName: "elevatebox_followup",
    templateLanguage: "en_US",
    allowedRecipient: "+919876543210",
    ...(logger ? { logger } : {}),
  };
}

test("WhatsApp defaults to an idempotent sanitized dry run", async () => {
  let fetchCount = 0;
  const logger = new CapturingLogger();
  const adapter = new MetaWhatsAppAdapter(
    { logger },
    (async () => {
      fetchCount += 1;
      throw new Error("dry run must not call Meta");
    }) as typeof fetch,
  );
  const local = message({
    attachments: ["resume.pdf"],
    consent: undefined,
  });
  const first = adapter.send(local);
  const replay = adapter.send(local);
  assert.strictEqual(first, replay);
  assert.match((await first).externalId, /^wamid\.dryrun\./);
  assert.equal(fetchCount, 0);
  const logs = JSON.stringify(logger.entries);
  assert.doesNotMatch(logs, /\+919876543210/);
  assert.doesNotMatch(logs, /whatsapp-call-1-once/);
  assert.doesNotMatch(logs, /resume\.pdf/);
});

test("matches Meta's approved template message contract", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const adapter = new MetaWhatsAppAdapter(
    liveConfig(),
    (async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.provider-1" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  );

  assert.deepEqual(await adapter.send(message()), {
    externalId: "wamid.provider-1",
    simulated: false,
  });
  assert.equal(
    capturedUrl,
    "https://graph.facebook.com/v23.0/123456789012345/messages",
  );
  assert.equal(capturedInit?.method, "POST");
  assert.equal(
    (capturedInit?.headers as Record<string, string>).Authorization,
    "Bearer meta-access-token-secret",
  );
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "919876543210",
    type: "template",
    template: {
      name: "elevatebox_followup",
      language: { code: "en_US" },
      components: [{
        type: "body",
        parameters: [{
          type: "text",
          text:
            "ElevateBox follow-up for the discussed website.\nLinks: https://assets.example.com/resume.pdf https://assets.example.com/architecture.png",
        }],
      }],
    },
  });
});

test("live WhatsApp requires consent and public attachment URLs", () => {
  const adapter = new MetaWhatsAppAdapter(
    liveConfig(),
    (async () => new Response()) as typeof fetch,
  );
  assert.throws(
    () => adapter.send(message({ consent: undefined })),
    /explicit WhatsApp consent/,
  );
  assert.throws(
    () => adapter.send(message({
      idempotencyKey: "another-key",
      attachments: ["resume.pdf"],
    })),
    /public credential-free HTTPS/,
  );
});

test("WhatsApp provider failures are safe and never retried ambiguously", async () => {
  let fetchCount = 0;
  const logger = new CapturingLogger();
  const adapter = new MetaWhatsAppAdapter(
    liveConfig(logger),
    (async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({
        error: {
          message: "sensitive +919876543210 meta-access-token-secret",
          code: 131026,
          error_subcode: 2494010,
        },
      }), { status: 400 });
    }) as typeof fetch,
  );
  await assert.rejects(adapter.send(message()), /HTTP 400 \(code 131026\)/);
  await assert.rejects(adapter.send(message()), /HTTP 400 \(code 131026\)/);
  assert.equal(fetchCount, 1);
  const logs = JSON.stringify(logger.entries);
  assert.doesNotMatch(logs, /\+919876543210/);
  assert.doesNotMatch(logs, /meta-access-token-secret/);
  assert.doesNotMatch(logs, /sensitive/);
});

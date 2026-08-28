import assert from "node:assert/strict";
import test from "node:test";

import type { OutgoingMessage } from "../src/contracts.ts";
import { OpenWAWhatsAppAdapter } from "../src/infrastructure/openwa-whatsapp-adapter.ts";
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
    attachments: ["https://assets.example.com/Resume-Ayanabh.pdf"],
    idempotencyKey: "openwa-call-1-once",
    consent: "EXPLICIT_WHATSAPP_OPT_IN",
    ...overrides,
  };
}

function liveConfig(logger?: SanitizedLogger) {
  return {
    dryRun: false,
    allowRealMessages: true,
    allowUnofficialClient: true,
    baseUrl: "http://127.0.0.1:2785/",
    apiKey: "openwa-api-key-secret",
    sessionId: "elevatebox-primary",
    allowedRecipient: "+919876543210",
    ...(logger ? { logger } : {}),
  };
}

test("OpenWA defaults to an idempotent sanitized dry run", async () => {
  let fetchCount = 0;
  const logger = new CapturingLogger();
  const adapter = new OpenWAWhatsAppAdapter(
    { logger },
    (async () => {
      fetchCount += 1;
      throw new Error("dry run must not call OpenWA");
    }) as typeof fetch,
  );
  const local = message({ attachments: ["resume.pdf"], consent: undefined });
  const first = adapter.send(local);
  const replay = adapter.send(local);
  assert.strictEqual(first, replay);
  assert.match((await first).externalId, /^openwa\.dryrun\./);
  assert.equal(fetchCount, 0);
  const logs = JSON.stringify(logger.entries);
  assert.doesNotMatch(logs, /\+919876543210/);
  assert.doesNotMatch(logs, /openwa-call-1-once/);
  assert.doesNotMatch(logs, /resume\.pdf/);
});

test("sends a PDF through OpenWA's native document contract", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const adapter = new OpenWAWhatsAppAdapter(
    liveConfig(),
    (async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("/contacts/check/")) {
        return new Response(JSON.stringify({
          number: "919876543210",
          exists: true,
          whatsappId: "12345678901234@lid",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        messageId: "true_12345678901234@lid_3EB0123456789",
        timestamp: 1_706_868_000,
      }), { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  );

  assert.deepEqual(await adapter.send(message()), {
    externalId: "true_12345678901234@lid_3EB0123456789",
    simulated: false,
  });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0]?.url,
    "http://127.0.0.1:2785/api/sessions/elevatebox-primary/contacts/check/919876543210",
  );
  assert.equal(requests[0]?.init?.method, "GET");
  assert.deepEqual(requests[0]?.init?.headers, {
    "X-API-Key": "openwa-api-key-secret",
  });
  assert.equal(
    requests[1]?.url,
    "http://127.0.0.1:2785/api/sessions/elevatebox-primary/messages/send-document",
  );
  assert.equal(requests[1]?.init?.method, "POST");
  assert.deepEqual(requests[1]?.init?.headers, {
    "Content-Type": "application/json",
    "X-API-Key": "openwa-api-key-secret",
  });
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
    chatId: "919876543210@c.us",
    url: "https://assets.example.com/Resume-Ayanabh.pdf",
    filename: "Resume-Ayanabh.pdf",
    mimetype: "application/pdf",
    caption: "ElevateBox follow-up for the discussed website.",
  });
});

test("uses send-text when a follow-up has no attachment", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const adapter = new OpenWAWhatsAppAdapter(
    liveConfig(),
    (async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("/contacts/check/")) {
        return new Response(JSON.stringify({
          number: "919876543210",
          exists: true,
          whatsappId: "919876543210@c.us",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ messageId: "message-text-1" }), {
        status: 201,
      });
    }) as typeof fetch,
  );

  await adapter.send(message({ attachments: [] }));
  assert.match(requests[1]?.url ?? "", /\/messages\/send-text$/);
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
    chatId: "919876543210@c.us",
    text: "ElevateBox follow-up for the discussed website.",
  });
});

test("live OpenWA requires both acknowledgements, consent, and an allowed recipient", () => {
  assert.throws(
    () => new OpenWAWhatsAppAdapter({ ...liveConfig(), allowUnofficialClient: false }),
    /risk acknowledgement/,
  );
  assert.throws(
    () => new OpenWAWhatsAppAdapter({ ...liveConfig(), allowRealMessages: false }),
    /allowRealMessages/,
  );
  const adapter = new OpenWAWhatsAppAdapter(
    liveConfig(),
    (async () => new Response()) as typeof fetch,
  );
  assert.throws(
    () => adapter.send(message({ consent: undefined })),
    /explicit WhatsApp consent/,
  );
  assert.throws(
    () => adapter.send(message({
      idempotencyKey: "different-recipient",
      to: "+919999999999",
    })),
    /not allowed/,
  );
});

test("OpenWA permits loopback HTTP but requires HTTPS for remote gateways", () => {
  assert.doesNotThrow(() => new OpenWAWhatsAppAdapter(liveConfig()));
  assert.doesNotThrow(() => new OpenWAWhatsAppAdapter({
    ...liveConfig(),
    baseUrl: "https://openwa.example.com",
  }));
  assert.throws(
    () => new OpenWAWhatsAppAdapter({
      ...liveConfig(),
      baseUrl: "http://openwa.example.com",
    }),
    /must use HTTPS/,
  );
});

test("live OpenWA accepts one PDF and refuses link-style attachment batches", () => {
  const adapter = new OpenWAWhatsAppAdapter(liveConfig());
  assert.throws(
    () => adapter.send(message({
      attachments: [
        "https://assets.example.com/resume.pdf",
        "https://assets.example.com/brochure.pdf",
      ],
    })),
    /at most one PDF/,
  );
  assert.throws(
    () => adapter.send(message({
      idempotencyKey: "not-a-pdf",
      attachments: ["https://assets.example.com/architecture.png"],
    })),
    /must be PDF/,
  );
});

test("OpenWA failures are sanitized and never retried ambiguously", async () => {
  let fetchCount = 0;
  const logger = new CapturingLogger();
  const adapter = new OpenWAWhatsAppAdapter(
    liveConfig(logger),
    (async (url) => {
      fetchCount += 1;
      if (String(url).includes("/contacts/check/")) {
        return new Response(JSON.stringify({
          number: "919876543210",
          exists: true,
          whatsappId: "919876543210@c.us",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        code: "SESSION_NOT_READY",
        message: "sensitive +919876543210 openwa-api-key-secret",
      }), { status: 409 });
    }) as typeof fetch,
  );
  await assert.rejects(
    adapter.send(message()),
    /HTTP 409 \(code SESSION_NOT_READY\)/,
  );
  await assert.rejects(
    adapter.send(message()),
    /HTTP 409 \(code SESSION_NOT_READY\)/,
  );
  assert.equal(fetchCount, 2);
  const logs = JSON.stringify(logger.entries);
  assert.doesNotMatch(logs, /\+919876543210/);
  assert.doesNotMatch(logs, /openwa-api-key-secret/);
  assert.doesNotMatch(logs, /sensitive/);
});

test("OpenWA refuses an unregistered recipient before invoking a send route", async () => {
  const urls: string[] = [];
  const adapter = new OpenWAWhatsAppAdapter(
    liveConfig(),
    (async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        number: "919876543210",
        exists: false,
        whatsappId: null,
      }), { status: 200 });
    }) as typeof fetch,
  );

  await assert.rejects(adapter.send(message()), /not registered/);
  assert.equal(urls.length, 1);
  assert.match(urls[0] ?? "", /\/contacts\/check\/919876543210$/);
});

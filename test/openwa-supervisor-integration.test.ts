import assert from "node:assert/strict";
import test from "node:test";

import { PrototypeSystem } from "../src/application/prototype-system.ts";
import { FixedClock } from "../src/infrastructure/clock.ts";
import { FakeSchedulerAdapter } from "../src/infrastructure/fake-adapters.ts";
import { OpenWAWhatsAppAdapter } from "../src/infrastructure/openwa-whatsapp-adapter.ts";
import { NoopSanitizedLogger } from "../src/infrastructure/sanitized-logger.ts";
import { ScriptedLeadUnderstandingAdapter } from "../src/infrastructure/scripted-understanding.ts";

test("routes a consented supervisor action through ActionManager into OpenWA", async () => {
  let fetchCount = 0;
  let requestBody: Record<string, unknown> | undefined;
  const messaging = new OpenWAWhatsAppAdapter(
    {
      dryRun: false,
      allowRealMessages: true,
      allowUnofficialClient: true,
      baseUrl: "http://127.0.0.1:2785",
      apiKey: "contract-test-key",
      sessionId: "contract-test-session",
      allowedRecipient: "+919876543210",
      logger: new NoopSanitizedLogger(),
    },
    (async (url, init) => {
      fetchCount += 1;
      if (String(url).includes("/contacts/check/")) {
        return new Response(JSON.stringify({
          number: "919876543210",
          exists: true,
          whatsappId: "12345678901234@lid",
        }), { status: 200 });
      }
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        messageId: "supervisor-openwa-contract-message",
        timestamp: 1_706_868_000,
      }), { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  );
  const system = new PrototypeSystem(
    {
      leadPhone: "+919876543210",
      candidate: {
        candidatePhone: "+919999999999",
        resumeUrl: "",
      },
    },
    new FixedClock("2026-08-26T10:00:00.000Z"),
    messaging,
    new FakeSchedulerAdapter(),
    new ScriptedLeadUnderstandingAdapter({
      "openwa-supervisor-1": {
        businessDescription: "an e-commerce integration test",
        timeline: "this month",
        buyingSignals: ["clear_need", "pricing_interest"],
      },
      "openwa-supervisor-2": { buyingSignals: ["send_details"] },
    }),
  );
  const call = await system.startCall("openwa-supervisor-contract");

  await call.submitStableTurnAndWait({
    turnId: "openwa-supervisor-1",
    text: "We need an e-commerce site this month. What would it cost?",
    occurredAt: "2026-08-26T10:00:01.000Z",
  });
  await call.submitStableTurnAndWait({
    turnId: "openwa-supervisor-2",
    text: "Yes, send the details to this WhatsApp number.",
    occurredAt: "2026-08-26T10:00:02.000Z",
  });
  await call.idle();

  assert.equal(fetchCount, 2);
  assert.equal(requestBody?.chatId, "919876543210@c.us");
  assert.equal(call.state().actions.hotWhatsappSent, true);
  const success = system.eventsFor(call.callId).find(
    (event) => event.type === "action.succeeded",
  );
  assert.ok(success);
  assert.equal(
    (success.payload as { externalId?: string }).externalId,
    "supervisor-openwa-contract-message",
  );
  assert.equal((success.payload as { simulated?: boolean }).simulated, false);
});

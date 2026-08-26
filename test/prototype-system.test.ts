import assert from "node:assert/strict";
import test from "node:test";

import { PrototypeSystem } from "../src/application/prototype-system.ts";
import type { LeadUnderstandingPort } from "../src/contracts.ts";
import { FixedClock } from "../src/infrastructure/clock.ts";
import {
  FakeMessagingAdapter,
  FakeSchedulerAdapter,
} from "../src/infrastructure/fake-adapters.ts";
import { replayLeadState } from "../src/domain/replay.ts";
import {
  ScriptedLeadUnderstandingAdapter,
  type ScriptedLeadPatch,
} from "../src/infrastructure/scripted-understanding.ts";

function buildSystem(
  patches: Record<string, ScriptedLeadPatch>,
  options: { messagingFailures?: number; delayMs?: number } = {},
) {
  const clock = new FixedClock("2026-08-26T10:00:00.000Z");
  const messaging = new FakeMessagingAdapter({
    delayMs: options.delayMs ?? 0,
    failAttempts: options.messagingFailures ?? 0,
  });
  const scheduler = new FakeSchedulerAdapter();
  const understanding = new ScriptedLeadUnderstandingAdapter(patches);
  const system = new PrototypeSystem(
    {
      leadPhone: "+918688664337",
      candidate: {
        candidatePhone: "+919999999999",
        resumeUrl: "resume.pdf",
        architectureUrl: "architecture.png",
      },
    },
    clock,
    messaging,
    scheduler,
    understanding,
  );
  return { system, messaging, scheduler };
}

test("fires one high-intent WhatsApp while active, books callback, and follows up after end", async () => {
  const { system, messaging, scheduler } = buildSystem({
    "turn-1": {
      language: "EN",
      businessDescription: "a circular-fashion rental marketplace",
      products: ["designer occasion wear", "monthly accessory boxes"],
      productCount: 250,
      buyingSignals: ["clear_need"],
    },
    "turn-2": {
      budgetInr: 80_000,
      requirements: [
        { text: "rental return workflow", importance: "HARD" },
        { text: "damage-deposit tracking", importance: "HARD" },
        "Razorpay payments",
      ],
    },
    "turn-3": {
      timeline: "this week",
      requirements: ["WhatsApp size-consultation handoff"],
      buyingSignals: ["start_soon", "send_details"],
    },
    "turn-4": { callbackPhrase: "tomorrow morning" },
  }, { delayMs: 20 });
  const call = await system.startCall("call-1");

  call.submitStableTurn({
    turnId: "turn-1",
    text: "I need a saree website for 250 products.",
    occurredAt: "2026-08-26T10:00:01.000Z",
  });
  call.submitStableTurn({
    turnId: "turn-2",
    text: "Budget is around 80,000 and I need COD, Razorpay and inventory.",
    occurredAt: "2026-08-26T10:00:02.000Z",
  });
  call.submitStableTurn({
    turnId: "turn-3",
    text: "How soon can you start this week? Send the details on WhatsApp.",
    occurredAt: "2026-08-26T10:00:03.000Z",
  });

  assert.equal(messaging.deliveries.length, 0, "submitStableTurn must not wait for provider I/O");
  await call.idle();
  assert.equal(call.state().callState, "ACTIVE");
  assert.equal(call.state().intent, "HOT");
  assert.equal(messaging.deliveries.length, 1);
  assert.equal(call.state().actions.hotWhatsappSent, true);

  call.submitStableTurn({
    turnId: "turn-3",
    text: "How soon can you start this week? Send the details on WhatsApp.",
    occurredAt: "2026-08-26T10:00:03.000Z",
  });
  call.submitStableTurn({
    turnId: "turn-4",
    text: "Call me back tomorrow morning.",
    occurredAt: "2026-08-26T10:00:04.000Z",
  });
  await call.idle();
  assert.equal(messaging.deliveries.length, 1, "duplicate turn must not duplicate WhatsApp");
  assert.equal(scheduler.bookings.length, 1);
  assert.equal(scheduler.bookings[0]?.scheduledAt, "2026-08-27T04:30:00.000Z");

  call.end();
  await call.idle();
  assert.equal(call.state().callState, "ENDED");
  assert.equal(messaging.deliveries.length, 2);
  assert.deepEqual(messaging.deliveries[1]?.attachments, ["resume.pdf", "architecture.png"]);

  const persistedEvents = system.eventsFor("call-1");
  assert.deepEqual(replayLeadState("call-1", persistedEvents), call.state());
  const eventTypes = persistedEvents.map((event) => event.type);
  assert.ok(eventTypes.includes("turn.duplicate_ignored"));
  assert.ok(eventTypes.includes("lead.classification.changed"));
  assert.equal(
    eventTypes.filter((type) => type === "lead.classification.evaluated").length,
    4,
  );
  assert.equal(eventTypes.filter((type) => type === "action.succeeded").length, 3);
});

test("retries a transient provider failure without duplicating delivery", async () => {
  const { system, messaging } = buildSystem({
    "turn-1": {
      businessDescription: "bespoke aquarium maintenance subscriptions",
      budgetInr: 100_000,
      timeline: "this week",
      buyingSignals: ["clear_need", "start_soon", "send_details"],
      requirements: ["recurring service slots", "water-quality history"],
    },
  }, { messagingFailures: 1 });
  const call = await system.startCall("call-retry");
  call.submitStableTurn({
    turnId: "turn-1",
    text: "I need a website. Budget is 1 lakh, start this week and send details on WhatsApp.",
    occurredAt: "2026-08-26T10:00:01.000Z",
  });
  await call.idle();

  assert.equal(messaging.deliveries.length, 1);
  const events = system.eventsFor("call-retry");
  assert.equal(events.filter((event) => event.type === "action.started").length, 2);
  assert.equal(events.filter((event) => event.type === "action.succeeded").length, 1);
  assert.equal(events.filter((event) => event.type === "action.failed").length, 0);
});

test("queues a failure directive and never marks a failed message as sent", async () => {
  const { system, messaging } = buildSystem({
    "turn-1": {
      businessDescription: "bespoke aquarium maintenance subscriptions",
      budgetInr: 100_000,
      timeline: "this week",
      buyingSignals: ["clear_need", "start_soon", "send_details"],
      requirements: ["recurring service slots", "water-quality history"],
    },
  }, { messagingFailures: 2 });
  const call = await system.startCall("call-failure");
  call.submitStableTurn({
    turnId: "turn-1",
    text: "I need a website. Budget is 1 lakh, start this week and send details on WhatsApp.",
    occurredAt: "2026-08-26T10:00:01.000Z",
  });
  await call.idle();

  assert.equal(messaging.deliveries.length, 0);
  assert.equal(call.state().actions.hotWhatsappSent, false);
  assert.ok(call.takeDirectives().some((item) => item.intent === "REPORT_ACTION_FAILURE"));
  assert.ok(system.eventsFor("call-failure").some((event) => event.type === "action.failed"));
});

test("records a lead-analysis failure and recovers on the next stable turn", async () => {
  let attempts = 0;
  const understanding: LeadUnderstandingPort = {
    async understand(input) {
      attempts += 1;
      if (attempts === 1) throw new Error("incomplete: max_output_tokens");
      return {
        locations: [],
        products: [],
        requirements: [],
        blockers: [],
        buyingSignals: [{
          value: "clear_need",
          confidence: 0.9,
          sourceTurnIds: [input.turn.turnId],
        }],
      };
    },
  };
  const system = new PrototypeSystem(
    {
      leadPhone: "+918688664337",
      candidate: {
        candidatePhone: "+919999999999",
        resumeUrl: "resume.pdf",
        architectureUrl: "architecture.png",
      },
    },
    new FixedClock("2026-08-26T10:00:00.000Z"),
    new FakeMessagingAdapter(),
    new FakeSchedulerAdapter(),
    understanding,
  );
  const call = await system.startCall("analysis-recovery");

  await call.submitStableTurnAndWait({
    turnId: "turn-failed",
    text: "Hindi is fine.",
    occurredAt: "2026-08-26T10:00:01.000Z",
  });
  await call.submitStableTurnAndWait({
    turnId: "turn-recovered",
    text: "I need a portfolio website.",
    occurredAt: "2026-08-26T10:00:02.000Z",
  });

  assert.equal(call.state().intent, "WARM");
  const events = system.eventsFor("analysis-recovery");
  assert.equal(events.filter((event) => event.type === "lead.analysis.failed").length, 1);
  assert.equal(
    events.filter((event) => event.type === "lead.classification.evaluated").length,
    1,
  );
});

test("analyzes stable turns concurrently but applies lead state in turn order", async () => {
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let active = 0;
  let maxActive = 0;
  const understanding: LeadUnderstandingPort = {
    async understand(input) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (input.turn.turnId === "parallel-1") await firstCanFinish;
      active -= 1;
      return {
        locations: [{
          value: input.turn.turnId,
          confidence: 0.9,
          sourceTurnIds: [input.turn.turnId],
        }],
        products: [],
        requirements: [],
        blockers: [],
        buyingSignals: [],
      };
    },
  };
  const system = new PrototypeSystem(
    {
      leadPhone: "+918688664337",
      candidate: {
        candidatePhone: "+919999999999",
        resumeUrl: "resume.pdf",
        architectureUrl: "architecture.png",
      },
    },
    new FixedClock("2026-08-26T10:00:00.000Z"),
    new FakeMessagingAdapter(),
    new FakeSchedulerAdapter(),
    understanding,
  );
  const call = await system.startCall("parallel-analysis");

  call.submitStableTurn({
    turnId: "parallel-1",
    text: "First turn",
    occurredAt: "2026-08-26T10:00:01.000Z",
  });
  call.submitStableTurn({
    turnId: "parallel-2",
    text: "Second turn",
    occurredAt: "2026-08-26T10:00:02.000Z",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(maxActive, 2, "lead model calls should overlap");
  releaseFirst();
  await call.idle();

  const events = system.eventsFor("parallel-analysis");
  assert.deepEqual(
    events
      .filter((event) => event.type === "lead.analysis.completed")
      .map((event) => event.sourceTurnIds[0]),
    ["parallel-2", "parallel-1"],
    "provider completions may arrive out of order",
  );
  assert.deepEqual(
    events
      .filter((event) =>
        event.type === "lead.state.updated" && event.sourceTurnIds.length > 0
      )
      .map((event) => event.sourceTurnIds[0]),
    ["parallel-1", "parallel-2"],
    "state application must preserve transcript order",
  );
  assert.deepEqual(
    call.state().locations.map((item) => item.value),
    ["parallel-1", "parallel-2"],
  );
});

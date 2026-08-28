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
      },
    },
    clock,
    messaging,
    scheduler,
    understanding,
  );
  return { system, messaging, scheduler };
}

test("fires one high-intent WhatsApp while active without duplicating it after end", async () => {
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
  assert.match(
    messaging.deliveries[0]?.body ?? "",
    /^Hi, I am Ayanabh\. My number is \+919999999999\. We spoke about /,
  );
  assert.match(messaging.deliveries[0]?.body ?? "", /attached my resume as discussed/);
  assert.match(messaging.deliveries[0]?.body ?? "", /around 250 products/);
  assert.match(messaging.deliveries[0]?.body ?? "", /budget of about ₹80,000/);
  assert.match(messaging.deliveries[0]?.body ?? "", /this week timeline/);
  assert.match(messaging.deliveries[0]?.body ?? "", /rental return workflow/);
  assert.match(messaging.deliveries[0]?.body ?? "", /damage-deposit tracking/);
  assert.doesNotMatch(
    messaging.deliveries[0]?.body ?? "",
    /(?:business|requirements|timeline|budget):/i,
  );
  assert.ok(
    call.takeDirectives().some((item) =>
      item.intent === "CONFIRM_ACTION_SUCCESS" && item.data.simulated === true
    ),
    "dry-run success must never be announced as a real send",
  );

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
  assert.equal(messaging.deliveries.length, 1);
  assert.deepEqual(messaging.deliveries[0]?.attachments, ["resume.pdf"]);

  const persistedEvents = system.eventsFor("call-1");
  assert.deepEqual(replayLeadState("call-1", persistedEvents), call.state());
  const eventTypes = persistedEvents.map((event) => event.type);
  assert.ok(eventTypes.includes("turn.duplicate_ignored"));
  assert.ok(eventTypes.includes("lead.classification.changed"));
  assert.equal(
    eventTypes.filter((type) => type === "lead.classification.evaluated").length,
    4,
  );
  assert.equal(eventTypes.filter((type) => type === "action.succeeded").length, 2);
  assert.ok(
    persistedEvents.some((event) =>
      event.type === "action.succeeded" &&
      (event.payload as { simulated?: boolean }).simulated === true
    ),
  );
});

test("turns a HOT price-and-timeline enquiry into one confident WhatsApp handoff", async () => {
  const { system, messaging } = buildSystem({
    "hot-offer-1": {
      businessDescription: "a specialty coffee subscription",
      timeline: "launch next month",
      buyingSignals: ["clear_need", "pricing_interest"],
    },
    "hot-offer-2": { buyingSignals: ["send_details"] },
  });
  const call = await system.startCall("call-hot-offer");

  await call.submitStableTurnAndWait({
    turnId: "hot-offer-1",
    text: "We want the site next month. What would it cost?",
    occurredAt: "2026-08-26T10:00:01.000Z",
  });
  assert.equal(call.state().intent, "HOT");
  assert.equal(messaging.deliveries.length, 0);
  assert.ok(call.takeDirectives().some((item) => item.intent === "ASK_SEND_PERMISSION"));

  await call.submitStableTurnAndWait({
    turnId: "hot-offer-2",
    text: "Yes, this number is fine for WhatsApp.",
    occurredAt: "2026-08-26T10:00:02.000Z",
  });
  await call.idle();
  assert.equal(messaging.deliveries.length, 1);
  assert.equal(call.state().actions.hotWhatsappSent, true);
});

test("captures a WARM timing barrier, requests a callback time, and books it", async () => {
  const { system, messaging, scheduler } = buildSystem({
    "warm-1": {
      businessDescription: "an organic grocery delivery business",
      buyingSignals: ["clear_need"],
      blockers: ["timing_barrier"],
    },
    "warm-2": { callbackPhrase: "tomorrow morning" },
  });
  const call = await system.startCall("call-warm");

  await call.submitStableTurnAndWait({
    turnId: "warm-1",
    text: "We need the store, but this month is too busy.",
    occurredAt: "2026-08-26T10:00:01.000Z",
  });
  assert.equal(call.state().intent, "WARM");
  assert.ok(call.takeDirectives().some((item) => item.intent === "ASK_CALLBACK_TIME"));
  assert.equal(messaging.deliveries.length, 0);

  await call.submitStableTurnAndWait({
    turnId: "warm-2",
    text: "Call me tomorrow morning.",
    occurredAt: "2026-08-26T10:00:02.000Z",
  });
  await call.idle();
  assert.equal(scheduler.bookings.length, 1);

  await call.endAndWait();
  assert.equal(
    messaging.deliveries.length,
    0,
    "a callback request is not also WhatsApp consent",
  );
});

test("proposes 6 PM for a vague day and books only after confirmation", async () => {
  const { system, scheduler } = buildSystem({
    "language-choice": { language: "EN" },
    "callback-vague": { callbackPhrase: "tomorrow" },
    "callback-yes": { callbackPhrase: "yes" },
  });
  const call = await system.startCall("call-callback-confirmation");

  await call.submitStableTurnAndWait({
    turnId: "language-choice",
    text: "English.",
    occurredAt: "2026-08-26T10:00:00.000Z",
    precedingAssistantText: "Which language are you comfortable with?",
  });

  await call.submitStableTurnAndWait({
    turnId: "callback-vague",
    text: "Tomorrow.",
    occurredAt: "2026-08-26T10:00:01.000Z",
    precedingAssistantText: "When should I call you back?",
  });
  assert.equal(call.state().callback.awaitingConfirmation, true);
  assert.equal(call.state().callback.proposedAt, "2026-08-27T12:30:00.000Z");
  assert.equal(scheduler.bookings.length, 0);
  assert.ok(call.takeDirectives().some((item) =>
    item.intent === "ASK_CALLBACK_CLARIFICATION" && item.data.proposedLocalTime === "6 PM"
  ));

  await call.submitStableTurnAndWait({
    turnId: "callback-yes",
    text: "Yes.",
    occurredAt: "2026-08-26T10:00:02.000Z",
    precedingAssistantText: "Would 6 PM tomorrow work?",
  });
  await call.idle();
  assert.equal(call.state().callback.booked, true);
  assert.equal(scheduler.bookings[0]?.scheduledAt, "2026-08-27T12:30:00.000Z");
  assert.equal(scheduler.bookings[0]?.preferredLanguage, "EN");
});

test("makes a declined callback with no alternative COLD without bypassing WhatsApp consent", async () => {
  const { system, messaging } = buildSystem({
    "callback-vague": { callbackPhrase: "tomorrow" },
    "callback-no": {},
  });
  const call = await system.startCall("call-callback-declined");
  await call.submitStableTurnAndWait({
    turnId: "callback-vague",
    text: "Tomorrow.",
    occurredAt: "2026-08-26T10:00:01.000Z",
  });
  call.takeDirectives();
  await call.submitStableTurnAndWait({
    turnId: "callback-no",
    text: "No.",
    occurredAt: "2026-08-26T10:00:02.000Z",
    precedingAssistantText: "Would 6 PM tomorrow work?",
  });
  await call.idle();
  assert.equal(call.state().intent, "COLD");
  assert.equal(call.state().callback.declinedWithoutAlternative, true);
  assert.equal(messaging.deliveries.length, 0);
  assert.ok(call.takeDirectives().some((item) =>
    item.intent === "ASK_SEND_PERMISSION" &&
    item.data.callbackDeclinedWithoutAlternative === true
  ));
});

test("sends one resume follow-up for a COLD just-looking lead and moves on", async () => {
  const { system, messaging } = buildSystem({
    "cold-1": { blockers: ["just_looking"] },
    "cold-2": { buyingSignals: ["send_details"] },
  });
  const call = await system.startCall("call-cold");

  await call.submitStableTurnAndWait({
    turnId: "cold-1",
    text: "I am only browsing, I do not have a plan or budget yet.",
    occurredAt: "2026-08-26T10:00:01.000Z",
  });
  await call.idle();
  assert.equal(call.state().intent, "COLD");
  assert.equal(call.state().actions.coldBrochureSent, false);
  assert.equal(messaging.deliveries.length, 0);
  assert.ok(
    call.takeDirectives().some((item) => item.intent === "ASK_SEND_PERMISSION"),
  );

  await call.submitStableTurnAndWait({
    turnId: "cold-2",
    text: "Yes, send the resume to this number on WhatsApp.",
    occurredAt: "2026-08-26T10:00:02.000Z",
  });
  await call.idle();
  assert.equal(call.state().actions.coldBrochureSent, true);
  assert.equal(messaging.deliveries.length, 1);
  assert.deepEqual(messaging.deliveries[0]?.attachments, ["resume.pdf"]);
  assert.ok(
    system.eventsFor("call-cold").some((event) =>
      event.type === "action.requested" &&
      (event.payload as { kind?: string }).kind === "SEND_COLD_BROCHURE"
    ),
  );

  await call.endAndWait();
  assert.equal(messaging.deliveries.length, 1, "call end must not duplicate the resume");
});

test("suppresses every follow-up when a COLD lead opts out", async () => {
  const { system, messaging } = buildSystem({
    "opt-out-1": { negativeSignals: ["do_not_contact"] },
  });
  const call = await system.startCall("call-opt-out");

  await call.submitStableTurnAndWait({
    turnId: "opt-out-1",
    text: "Do not contact me again.",
    occurredAt: "2026-08-26T10:00:01.000Z",
  });
  await call.idle();
  assert.equal(call.state().intent, "COLD");
  assert.equal(messaging.deliveries.length, 0);

  await call.endAndWait();
  assert.equal(messaging.deliveries.length, 0);
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

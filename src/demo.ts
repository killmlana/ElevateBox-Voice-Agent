import { PrototypeSystem } from "./application/prototype-system.ts";
import { FixedClock } from "./infrastructure/clock.ts";
import {
  FakeMessagingAdapter,
  FakeSchedulerAdapter,
} from "./infrastructure/fake-adapters.ts";
import { ScriptedLeadUnderstandingAdapter } from "./infrastructure/scripted-understanding.ts";

const clock = new FixedClock("2026-08-26T10:00:00.000Z");
const messaging = new FakeMessagingAdapter({ delayMs: 15 });
const scheduler = new FakeSchedulerAdapter({ delayMs: 10 });
const understanding = new ScriptedLeadUnderstandingAdapter({
  "turn-1": {
    language: "EN",
    businessDescription: "a made-to-order handloom saree and blouse studio",
    products: ["handloom sarees", "custom-fit blouses", "bridal styling consultations"],
    productCount: 250,
    buyingSignals: ["clear_need"],
  },
  "turn-2": {
    budgetInr: 80_000,
    requirements: [
      { text: "cash on delivery", importance: "HARD" },
      { text: "Razorpay payments", importance: "HARD" },
      { text: "inventory by fabric and blouse size", importance: "HARD" },
    ],
  },
  "turn-3": {
    timeline: "this week",
    requirements: [
      { text: "WhatsApp styling consultation handoff", importance: "SOFT" },
    ],
    buyingSignals: ["start_soon", "send_details"],
  },
  "turn-4": { callbackPhrase: "tomorrow morning" },
});
const system = new PrototypeSystem(
  {
    leadPhone: "+918688664337",
    candidate: {
      candidatePhone: "+91-REPLACE-WITH-YOUR-NUMBER",
      resumeUrl: "resume.pdf",
    },
  },
  clock,
  messaging,
  scheduler,
  understanding,
);

const callId = "demo-call-001";
const call = await system.startCall(callId);

call.submitStableTurn({
  turnId: "turn-1",
  occurredAt: "2026-08-26T10:00:05.000Z",
  text: "I want a website for my saree store. We have around 250 products.",
});
call.submitStableTurn({
  turnId: "turn-2",
  occurredAt: "2026-08-26T10:00:18.000Z",
  text: "My budget is around 80,000 rupees and I need COD, Razorpay and inventory.",
});
call.submitStableTurn({
  turnId: "turn-3",
  occurredAt: "2026-08-26T10:00:31.000Z",
  text: "Can you start this week? Please send me the details on WhatsApp.",
});
await call.idle();

const midCallDeliveryCount = messaging.deliveries.length;
const midCallDirectives = call.takeDirectives();

call.submitStableTurn({
  turnId: "turn-4",
  occurredAt: "2026-08-26T10:00:45.000Z",
  text: "Call me back tomorrow morning.",
});
await call.idle();
call.end();
await call.idle();

console.log(JSON.stringify({
  callId,
  midCallDeliveryCount,
  finalState: call.state(),
  directives: [...midCallDirectives, ...call.takeDirectives()],
  messages: messaging.deliveries,
  callbacks: scheduler.bookings,
  eventTypes: system.eventsFor(callId).map((event) => event.type),
}, null, 2));

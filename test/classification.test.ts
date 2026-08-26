import assert from "node:assert/strict";
import test from "node:test";

import { DeterministicLeadClassifier } from "../src/domain/classifier.ts";
import { applyLeadUpdate, createLeadState } from "../src/domain/lead-state.ts";
import { addDeterministicNegativeSignals } from "../src/domain/negative-intent.ts";
import {
  ScriptedLeadUnderstandingAdapter,
  type ScriptedLeadPatch,
} from "../src/infrastructure/scripted-understanding.ts";

const classifier = new DeterministicLeadClassifier();
const now = "2026-08-26T10:00:00.000Z";

async function stateFrom(...patches: ScriptedLeadPatch[]) {
  let state = createLeadState("classification-call", now);
  const fixtures = Object.fromEntries(
    patches.map((patch, index) => [`turn-${index + 1}`, patch]),
  );
  const understanding = new ScriptedLeadUnderstandingAdapter(fixtures);
  for (const [index] of patches.entries()) {
    const turnId = `turn-${index + 1}`;
    const update = await understanding.understand({
      turn: { turnId, text: `fixture ${turnId}`, occurredAt: now },
      currentState: state,
    });
    state = applyLeadUpdate(
      state,
      update,
      now,
    );
  }
  return state;
}

test("classifies accumulated budget, urgency and send-details evidence as HOT", async () => {
  const state = await stateFrom(
    {
      businessDescription: "a made-to-order festival hamper studio",
      products: ["regional snack hampers", "custom corporate gift boxes"],
      requirements: ["recipient-specific handwritten notes"],
      buyingSignals: ["clear_need"],
    },
    { budgetInr: 80_000 },
    {
      timeline: "launch before the festival pre-order window",
      buyingSignals: ["start_soon", "send_details"],
    },
  );
  const result = classifier.classify(state);
  assert.equal(result.intent, "HOT");
  assert.ok(result.evidenceTurnIds.includes("turn-2"));
  assert.ok(result.evidenceTurnIds.includes("turn-3"));
});

test("keeps a real lead with another decision-maker WARM", async () => {
  const state = await stateFrom({
    businessDescription: "community-supported urban farming subscriptions",
    budgetInr: 50_000,
    decisionMaker: "OTHER",
    blockers: ["other_decision_maker"],
    buyingSignals: ["clear_need"],
  });
  const result = classifier.classify(state);
  assert.equal(result.intent, "WARM");
  assert.match(result.rationale, /decision-maker/i);
});

test("keeps a concrete need with a timing barrier WARM", async () => {
  const state = await stateFrom({
    businessDescription: "a regional organic grocery store",
    buyingSignals: ["clear_need"],
    blockers: ["timing_barrier"],
  });
  const result = classifier.classify(state);
  assert.equal(result.intent, "WARM");
  assert.match(result.rationale, /timing/i);
});

test("classifies a concrete price-and-timeline enquiry as HOT without a stated budget", async () => {
  const state = await stateFrom({
    businessDescription: "a handmade stationery shop",
    timeline: "launch next month",
    buyingSignals: ["clear_need", "pricing_interest"],
  });
  const result = classifier.classify(state);
  assert.equal(result.intent, "HOT");
});

test("classifies a just-looking lead with no budget as COLD", async () => {
  const state = await stateFrom({ blockers: ["just_looking"] });
  const result = classifier.classify(state);
  assert.equal(result.intent, "COLD");
});

test("keeps price curiosity without a concrete need COLD", async () => {
  const state = await stateFrom({ buyingSignals: ["pricing_interest"] });
  const result = classifier.classify(state);
  assert.equal(result.intent, "COLD");
});

test("leaves an evidence-free greeting UNKNOWN", async () => {
  const state = await stateFrom({});
  const result = classifier.classify(state);
  assert.equal(result.intent, "UNKNOWN");
});

test("turns a repeated-call complaint and explicit opt-out into COLD with a negative score", async () => {
  const state = await stateFrom({
    negativeSignals: ["repeated_call_complaint", "do_not_contact"],
  });
  const result = classifier.classify(state);
  assert.equal(result.intent, "COLD");
  assert.ok(result.score < 0);
  assert.match(result.rationale, /contacted|negative|frustration/i);
});

test("recognizes the Hindi opt-out phrase used in the microphone trace", () => {
  const update = addDeterministicNegativeSignals({
    locations: [],
    products: [],
    requirements: [],
    blockers: [],
    buyingSignals: [],
    negativeSignals: [],
  }, "turn-hindi-opt-out", "हाँ हाँ कॉल मत कीजिएगा");
  assert.deepEqual(update.negativeSignals.map((item) => item.value), ["do_not_contact"]);
});

test("subtracts one score point for an individual without an existing business", async () => {
  const business = classifier.classify(await stateFrom({
    customerType: "BUSINESS",
    buyingSignals: ["clear_need"],
  }));
  const individual = classifier.classify(await stateFrom({
    customerType: "INDIVIDUAL",
    buyingSignals: ["clear_need"],
  }));

  assert.equal(individual.intent, "WARM");
  assert.equal(individual.score, business.score - 1);
  assert.deepEqual(
    individual.scoreBreakdown.find((item) => item.factor === "no existing business"),
    { factor: "no existing business", delta: -1 },
  );
});

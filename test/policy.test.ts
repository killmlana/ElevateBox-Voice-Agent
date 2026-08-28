import assert from "node:assert/strict";
import test from "node:test";

import type { Evidence, LeadState } from "../src/contracts.ts";
import { createLeadState } from "../src/domain/lead-state.ts";
import { LeadPolicy } from "../src/domain/policy.ts";

const now = "2026-08-26T10:00:00.000Z";
const policy = new LeadPolicy();

function signal(value: string): Evidence<string> {
  return { value, sourceTurnIds: ["turn-1"], confidence: 0.9 };
}

function stateWith(overrides: Partial<LeadState>): LeadState {
  return { ...createLeadState("policy-call", now), ...overrides };
}

const emptyUpdate = {
  locations: [],
  products: [],
  requirements: [],
  blockers: [],
  buyingSignals: [],
  negativeSignals: [],
};

function evaluate(previous: LeadState, current: LeadState, update = emptyUpdate) {
  return policy.evaluate({
    previous,
    current,
    update,
    requestedActionKinds: new Set<string>(),
    now,
  });
}

test("sends hot details while the lead is still HOT", () => {
  const previous = stateWith({ intent: "WARM" });
  const current = stateWith({
    intent: "HOT",
    hotPeaked: true,
    buyingSignals: [signal("send_details")],
  });

  const kinds = evaluate(previous, current).commands.map((c) => c.kind);
  assert.ok(kinds.includes("SEND_HOT_DETAILS"));
});

test("asks permission on the rising edge into HOT without send_details", () => {
  const previous = stateWith({ intent: "WARM" });
  const current = stateWith({ intent: "HOT", hotPeaked: true });

  const decision = evaluate(previous, current);
  assert.equal(decision.commands.length, 0);
  assert.ok(
    decision.directives.some((d) => d.intent === "ASK_SEND_PERMISSION"),
    "expected ASK_SEND_PERMISSION directive",
  );
});

// Regression: a lead that peaked at HOT, was asked for permission, then agreed
// while a blocker pushed intent back to WARM must still get the details sent.
// Before sticky consent this fell through to the post-call follow-up, so the
// voice model could never confirm the send during the call.
test("sends hot details after consent even once intent regresses to WARM", () => {
  const previous = stateWith({ intent: "HOT", hotPeaked: true });
  const current = stateWith({
    intent: "WARM",
    hotPeaked: true,
    blockers: [signal("timing_barrier")],
    buyingSignals: [signal("send_details")],
  });

  const kinds = evaluate(previous, current).commands.map((c) => c.kind);
  assert.ok(
    kinds.includes("SEND_HOT_DETAILS"),
    `expected SEND_HOT_DETAILS, got ${JSON.stringify(kinds)}`,
  );
});

test("does not send when the lead never reached HOT", () => {
  const previous = stateWith({ intent: "WARM" });
  const current = stateWith({
    intent: "WARM",
    buyingSignals: [signal("send_details")],
  });

  const kinds = evaluate(previous, current).commands.map((c) => c.kind);
  assert.ok(!kinds.includes("SEND_HOT_DETAILS"));
});

test("does not resend once hotWhatsappSent is recorded", () => {
  const previous = stateWith({ intent: "HOT", hotPeaked: true });
  const current = stateWith({
    intent: "WARM",
    hotPeaked: true,
    buyingSignals: [signal("send_details")],
    actions: {
      hotWhatsappSent: true,
      coldBrochureSent: false,
      callbackBooked: false,
      finalFollowupSent: false,
    },
  });

  const kinds = evaluate(previous, current).commands.map((c) => c.kind);
  assert.ok(!kinds.includes("SEND_HOT_DETAILS"));
});

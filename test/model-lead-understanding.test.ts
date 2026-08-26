import assert from "node:assert/strict";
import test from "node:test";

import { createLeadState } from "../src/domain/lead-state.ts";
import {
  ModelLeadUnderstandingAdapter,
  type StructuredLeadPatchClient,
} from "../src/infrastructure/model-lead-understanding.ts";

test("accepts arbitrary products and requirements without a catalogue", async () => {
  let observedInstruction = "";
  let observedPrecedingAssistantText = "";
  const client: StructuredLeadPatchClient = {
    async generate(input) {
      observedInstruction = input.instruction;
      observedPrecedingAssistantText = input.precedingAssistantText ?? "";
      return {
        language: "MIXED",
        businessDescription: "a memorial-tree gifting service for remote families",
        customerType: "BUSINESS",
        locations: ["Hyderabad"],
        products: [
          "GPS-tagged native sapling dedications",
          "annual growth-story subscriptions",
        ],
        productCount: null,
        budgetInr: null,
        timeline: null,
        requirements: [
          {
            text: "family members must receive a private planting timeline",
            importance: "HARD",
          },
          {
            text: "watercolour-style digital certificates",
            importance: "SOFT",
          },
        ],
        decisionMaker: null,
        blockers: ["seasonal planting availability is uncertain"],
        buyingSignals: ["start_soon"],
        callbackPhrase: null,
        confidence: 0.91,
      };
    },
  };
  const adapter = new ModelLeadUnderstandingAdapter(client);
  const turnId = "unseen-domain-turn";
  const patch = await adapter.understand({
    turn: {
      turnId,
      text: "We plant memorial trees and send families a private growth story.",
      occurredAt: "2026-08-26T10:00:00.000Z",
      precedingAssistantText: "What kind of business do you run?",
    },
    currentState: createLeadState("model-call", "2026-08-26T10:00:00.000Z"),
  });

  assert.match(observedInstruction, /compact/i);
  assert.match(observedInstruction, /context only/i);
  assert.equal(observedPrecedingAssistantText, "What kind of business do you run?");
  assert.equal(
    patch.businessDescription?.value,
    "a memorial-tree gifting service for remote families",
  );
  assert.equal(patch.customerType?.value, "BUSINESS");
  assert.equal(patch.locations[0]?.value, "Hyderabad");
  assert.deepEqual(
    patch.products.map((item) => item.value),
    ["GPS-tagged native sapling dedications", "annual growth-story subscriptions"],
  );
  assert.equal(patch.requirements[0]?.value.importance, "HARD");
  assert.deepEqual(patch.requirements[0]?.sourceTurnIds, [turnId]);
  assert.equal(
    patch.blockers[0]?.value,
    "seasonal planting availability is uncertain",
  );
});

test("rejects malformed model confidence before state mutation", async () => {
  const client: StructuredLeadPatchClient = {
    async generate() {
      return {
        products: ["arbitrary product"],
        requirements: [],
        blockers: [],
        buyingSignals: [],
        confidence: 1.4,
      };
    },
  };
  const adapter = new ModelLeadUnderstandingAdapter(client);
  await assert.rejects(
    adapter.understand({
      turn: {
        turnId: "bad-turn",
        text: "arbitrary",
        occurredAt: "2026-08-26T10:00:00.000Z",
      },
      currentState: createLeadState("bad-call", "2026-08-26T10:00:00.000Z"),
    }),
    /confidence.*between 0 and 1/i,
  );
});

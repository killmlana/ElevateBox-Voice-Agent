import assert from "node:assert/strict";
import test from "node:test";

import { LEAD_PATCH_SCHEMA } from "../src/infrastructure/model-lead-understanding.ts";
import {
  OpenAIResponsesLeadPatchClient,
  type LeadRequestMetrics,
} from "../src/infrastructure/openai-responses-lead-client.ts";

test("uses strict Responses structured output with an independently configurable model", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fakeFetch: typeof fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  language: "EN",
                  businessDescription: "mobile observatories for apartment communities",
                  customerType: "BUSINESS",
                  locations: ["Hyderabad"],
                  products: ["rooftop telescope evenings"],
                  productCount: null,
                  budgetInr: null,
                  timeline: null,
                  requirements: [],
                  decisionMaker: null,
                  blockers: [],
                  buyingSignals: [],
                  callbackPhrase: null,
                  confidence: 0.93,
                }),
              },
            ],
          },
        ],
        usage: {
          input_tokens: 211,
          output_tokens: 83,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 294,
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-request-id": "req-success",
        },
      },
    );
  };
  let metrics: LeadRequestMetrics | undefined;
  const client = new OpenAIResponsesLeadPatchClient(
    {
      apiKey: "test-key",
      model: "replaceable-extraction-model",
      onRequestMetrics: (value) => { metrics = value; },
    },
    fakeFetch,
  );

  const result = await client.generate({
    turnId: "turn-1",
    instruction: "Extract only stated facts.",
    turnText: "We arrange rooftop telescope evenings.",
    schemaName: "lead_state_patch",
    schema: LEAD_PATCH_SCHEMA,
  });

  assert.equal(requestBody?.model, "replaceable-extraction-model");
  assert.equal(requestBody?.store, false);
  const text = requestBody?.text as Record<string, unknown>;
  const format = text.format as Record<string, unknown>;
  assert.equal(format.type, "json_schema");
  assert.equal(format.strict, true);
  assert.deepEqual(format.schema, LEAD_PATCH_SCHEMA);
  const requestInput = requestBody?.input as Array<Record<string, unknown>>;
  const requestContent = requestInput[0]?.content as Array<Record<string, unknown>>;
  const compactInput = JSON.parse(String(requestContent[0]?.text)) as Record<string, unknown>;
  assert.equal("accumulatedLeadState" in compactInput, false);
  assert.equal(metrics?.status, "completed");
  assert.equal(metrics?.requestId, "req-success");
  assert.equal(metrics?.inputTokens, 211);
  assert.equal(metrics?.outputTokens, 83);
  assert.equal(
    (result as Record<string, unknown>).businessDescription,
    "mobile observatories for apartment communities",
  );
});

test("reports sanitized Responses failures with the provider request id", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response("sensitive provider body", {
      status: 429,
      headers: { "x-request-id": "req-rate-limited" },
    });
  const client = new OpenAIResponsesLeadPatchClient(
    { apiKey: "test-key", model: "model-a" },
    fakeFetch,
  );

  await assert.rejects(
    client.generate({
      turnId: "turn-1",
      instruction: "extract",
      turnText: "hello",
      schemaName: "lead_state_patch",
      schema: LEAD_PATCH_SCHEMA,
    }),
    (error: Error) => {
      assert.match(error.message, /429.*req-rate-limited/);
      assert.doesNotMatch(error.message, /sensitive provider body/);
      return true;
    },
  );
});

test("reports a safe incomplete reason for lead extraction", async () => {
  const client = new OpenAIResponsesLeadPatchClient(
    { apiKey: "test-key", model: "model-a" },
    async () => new Response(JSON.stringify({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  );

  await assert.rejects(
    client.generate({
      turnId: "turn-1",
      instruction: "extract",
      turnText: "hello",
      schemaName: "lead_state_patch",
      schema: LEAD_PATCH_SCHEMA,
    }),
    /incomplete: max_output_tokens/,
  );
});

test("bounds parallel Responses requests without serializing them", async () => {
  let releaseRequests!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseRequests = resolve;
  });
  let active = 0;
  let maxActive = 0;
  const client = new OpenAIResponsesLeadPatchClient(
    { apiKey: "test-key", model: "model-a", maxConcurrency: 2 },
    async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await released;
      active -= 1;
      return new Response(JSON.stringify({
        status: "completed",
        output_text: JSON.stringify({ ok: true }),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  );
  const generate = (turnId: string) => client.generate({
    turnId,
    instruction: "extract",
    turnText: turnId,
    schemaName: "small_patch",
    schema: { type: "object" },
  });

  const pending = [generate("turn-1"), generate("turn-2"), generate("turn-3")];
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 2);
  releaseRequests();
  await Promise.all(pending);
  assert.equal(maxActive, 2);
});

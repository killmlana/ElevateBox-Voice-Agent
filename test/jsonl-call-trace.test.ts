import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonlCallTrace } from "../src/infrastructure/jsonl-call-trace.ts";

test("persists runtime and normalized domain events as ordered JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elevatebox-trace-"));
  try {
    const trace = new JsonlCallTrace("call/unsafe", directory);
    trace.record("runtime", "user.turn.completed", { transcript: "Hindi is fine." });
    trace.recordDomainEvent({
      eventId: "call-1:1",
      callId: "call/unsafe",
      seq: 1,
      type: "lead.classification.changed",
      occurredAt: "2026-08-26T10:00:00.000Z",
      sourceTurnIds: ["turn-1"],
      payload: { intent: "WARM", score: 1 },
    });
    await trace.close();

    assert.equal(trace.path, join(directory, "call_unsafe.jsonl"));
    const records = (await readFile(trace.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(records.map((record) => record.traceSeq), [1, 2]);
    assert.deepEqual(records.map((record) => record.type), [
      "user.turn.completed",
      "lead.classification.changed",
    ]);
    assert.equal(records[1]?.source, "domain");
  } finally {
    await rm(directory, { recursive: true });
  }
});

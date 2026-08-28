import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SanitizedJsonlEventSink } from "../src/infrastructure/sanitized-jsonl-event-sink.ts";
import { safeReference } from "../src/infrastructure/sanitized-logger.ts";

test("persists ordered production events without raw call content or provider errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elevatebox-safe-trace-"));
  const callId = "private-call-id";
  try {
    const sink = new SanitizedJsonlEventSink(directory);
    await sink.record({
      eventId: `${callId}:1`,
      callId,
      seq: 1,
      type: "turn.completed",
      occurredAt: "2026-08-27T10:00:00.000Z",
      sourceTurnIds: ["private-turn-id"],
      payload: {
        text: "Please send the resume to +919876543210.",
        languageHint: "EN",
      },
    });
    await sink.record({
      eventId: `${callId}:2`,
      callId,
      seq: 2,
      type: "action.failed",
      occurredAt: "2026-08-27T10:00:01.000Z",
      sourceTurnIds: [],
      payload: {
        commandId: "private-command-id",
        kind: "SEND_HOT_DETAILS",
        attempt: 2,
        error: "provider returned a sensitive failure body",
      },
    });
    await sink.record({
      eventId: `${callId}:3`,
      callId,
      seq: 3,
      type: "call.latency_summary",
      occurredAt: "2026-08-27T10:00:02.000Z",
      sourceTurnIds: [],
      payload: {
        measurements: [{
          name: "vad_turn_gap_ms",
          valueMs: 321,
          measuredAt: "2026-08-27T10:00:01.500Z",
        }],
        summary: {
          vad_turn_gap_ms: { count: 1, minMs: 321, p50Ms: 321, p95Ms: 321, maxMs: 321 },
        },
      },
    });

    const files = await readdir(directory);
    assert.deepEqual(files, [`2026-08-27-${safeReference(callId)}.jsonl`]);
    const content = await readFile(join(directory, files[0]!), "utf8");
    assert.doesNotMatch(content, /private-call-id|private-turn-id|private-command-id/);
    assert.doesNotMatch(content, /send the resume|919876543210|sensitive failure body/);
    const rows = content.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.seq), [1, 2, 3]);
    assert.equal(rows[0].payload.text.chars, 40);
    assert.equal(rows[1].payload.kind, "SEND_HOT_DETAILS");
    assert.equal(rows[2].payload.summary.vad_turn_gap_ms.p95Ms, 321);
  } finally {
    await rm(directory, { recursive: true });
  }
});

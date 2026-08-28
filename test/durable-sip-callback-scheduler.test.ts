import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CallbackBooking } from "../src/contracts.ts";
import { DurableSipCallbackScheduler } from "../src/infrastructure/durable-sip-callback-scheduler.ts";

test("persists and executes one scheduled SIP callback with its language", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elevatebox-callback-"));
  const statePath = join(directory, "callbacks.json");
  const executed: CallbackBooking[] = [];
  const scheduler = new DurableSipCallbackScheduler({ statePath });
  scheduler.setExecutor(async (booking) => {
    executed.push(booking);
  });
  await scheduler.start();
  try {
    const scheduledAt = new Date(Date.now() + 30).toISOString();
    const first = await scheduler.book({
      leadPhone: "+919876543210",
      scheduledAt,
      rawTime: "tomorrow at six",
      idempotencyKey: "callback-once",
      preferredLanguage: "TE",
    });
    const duplicate = await scheduler.book({
      leadPhone: "+919876543210",
      scheduledAt,
      rawTime: "tomorrow at six",
      idempotencyKey: "callback-once",
      preferredLanguage: "TE",
    });
    assert.equal(duplicate.externalId, first.externalId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(executed.length, 1);
    assert.equal(executed[0]?.preferredLanguage, "TE");
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as Array<{ status: string }>;
    assert.equal(persisted[0]?.status, "completed");
  } finally {
    await scheduler.close();
    await rm(directory, { recursive: true, force: true });
  }
});

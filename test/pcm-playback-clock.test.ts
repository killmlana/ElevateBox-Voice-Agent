import assert from "node:assert/strict";
import test from "node:test";

import { pacedPcmTargetBytes } from "../src/infrastructure/pcm-playback-clock.ts";

test("releases the final PCM16 sample without floating-point residue", () => {
  const totalBytes = 588_000;
  const deliveredBytes = totalBytes - 2;
  const targetBytes = pacedPcmTargetBytes({
    totalBytes,
    elapsedMs: 20_000,
    bufferMs: 80,
    bytesPerSecond: 48_000,
  });

  assert.equal(targetBytes, totalBytes);
  assert.equal(targetBytes - deliveredBytes, 2);
});

import assert from "node:assert/strict";
import test from "node:test";

import { loadProductionConfig } from "../src/production-config.ts";
import { createProductionApplication } from "../src/production.ts";
import { NoopSanitizedLogger } from "../src/infrastructure/sanitized-logger.ts";

test("production composition root performs prepare and dial with zero network in default mode", async () => {
  let fetchCount = 0;
  const config = loadProductionConfig({
    CONTROL_API_TOKEN: "production-test-control-token",
    LEAD_PHONE: "+919876543210",
    HOST: "127.0.0.1",
    PORT: "0",
  });
  const application = createProductionApplication(config, {
    logger: new NoopSanitizedLogger(),
    fetchFn: (async () => {
      fetchCount += 1;
      throw new Error("default production composition must not call fetch");
    }) as typeof fetch,
  });
  const address = await application.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    authorization: "Bearer production-test-control-token",
    "content-type": "application/json",
  };
  try {
    const prepared = await fetch(`${baseUrl}/calls/prepare`, {
      method: "POST",
      headers,
      body: JSON.stringify({ callId: "composition-1", promptVersion: "v1" }),
    });
    assert.equal(prepared.status, 201);
    const ready = await prepared.json() as {
      ready: boolean;
      callId: string;
      token: string;
    };
    assert.equal(ready.ready, true);

    const dialed = await fetch(`${baseUrl}/calls/dial`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        callId: ready.callId,
        token: ready.token,
        to: "+919876543210",
        idempotencyKey: "composition-1-once",
      }),
    });
    assert.equal(dialed.status, 202);
    const result = await dialed.json() as { simulated: boolean; status: string };
    assert.deepEqual(result, {
      providerCallId: "dryrun_7730a7b11fc6",
      status: "simulated",
      simulated: true,
    });
    assert.equal(fetchCount, 0);
  } finally {
    await application.close();
  }
});

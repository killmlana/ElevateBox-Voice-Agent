import assert from "node:assert/strict";
import test from "node:test";

import {
  AsteriskAriAdapter,
  asteriskResourceIds,
  type AsteriskEventSocket,
  type AsteriskEventSocketFactory,
  type AsteriskEventSocketHandlers,
} from "../src/infrastructure/asterisk-ari-adapter.ts";

class FakeEventSocket implements AsteriskEventSocket {
  readonly handlers: AsteriskEventSocketHandlers;

  constructor(handlers: AsteriskEventSocketHandlers) {
    this.handlers = handlers;
  }
  close(): void {}
  event(value: Record<string, unknown>): void {
    this.handlers.message(JSON.stringify(value));
  }
}

class FakeEventSocketFactory implements AsteriskEventSocketFactory {
  socket?: FakeEventSocket;
  url?: string;
  headers?: Readonly<Record<string, string>>;

  connect(options: {
    url: string;
    headers: Readonly<Record<string, string>>;
    handlers: AsteriskEventSocketHandlers;
  }): AsteriskEventSocket {
    this.url = options.url;
    this.headers = options.headers;
    this.socket = new FakeEventSocket(options.handlers);
    queueMicrotask(options.handlers.open);
    return this.socket;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("uses deterministic ARI resources and the Zadarma/OpenAI PJSIP contracts", async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const sockets = new FakeEventSocketFactory();
  const callId = "customer-call-1";
  const ids = asteriskResourceIds(callId);
  const fetchFn = (async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname.endsWith("/variable")) {
      const variable = url.searchParams.get("variable");
      if (variable === "CHANNEL(pjsip,call-id)") {
        return json({ value: "asterisk-sip-call-id" });
      }
      if (variable === "CHANNEL(audioreadformat)") return json({ value: "alaw" });
      if (variable === "CHANNEL(audiowriteformat)") return json({ value: "ulaw" });
    }
    if (init.method === "POST" && url.pathname.includes("/channels/")) {
      return json({ id: url.pathname.split("/").at(-1), state: "Down" });
    }
    if (init.method === "POST" && url.pathname.includes("/bridges/")) {
      return url.pathname.endsWith("/addChannel")
        ? new Response(null, { status: 204 })
        : json({ id: ids.bridgeId, channels: [] });
    }
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected ARI request ${init.method} ${url}`);
  }) as typeof fetch;
  const adapter = new AsteriskAriAdapter(
    {
      baseUrl: "http://127.0.0.1:8088/ari",
      username: "ari-user",
      password: "ari-password",
      app: "elevatebox",
      zadarmaEndpoint: "zadarma",
      openAIEndpoint: "openai",
      callIdPollIntervalMs: 1,
    },
    { fetchFn, socketFactory: sockets },
  );

  await adapter.start();
  assert.equal(sockets.url, "ws://127.0.0.1:8088/ari/events?app=elevatebox");
  assert.equal(
    sockets.headers?.Authorization,
    `Basic ${Buffer.from("ari-user:ari-password").toString("base64")}`,
  );

  const ai = await adapter.originateOpenAI(callId, "proj_elevatebox");
  assert.equal(ai.channelId, ids.aiChannelId);
  assert.equal(ai.sipCallId, "asterisk-sip-call-id");
  const aiRequest = requests.find((item) =>
    item.url.pathname.endsWith(`/channels/${ids.aiChannelId}`)
  );
  assert.equal(
    aiRequest?.url.searchParams.get("endpoint"),
    "PJSIP/openai/sip:proj_elevatebox@sip.api.openai.com;transport=tls",
  );
  assert.equal(aiRequest?.url.searchParams.get("formats"), "alaw,ulaw");
  assert.equal(aiRequest?.url.searchParams.get("app"), "elevatebox");

  sockets.socket!.event({
    type: "ChannelStateChange",
    channel: { id: ids.aiChannelId, state: "Up" },
  });
  await ai.answered;

  await adapter.startSilence(ids.aiChannelId);
  assert.ok(requests.some((item) =>
    item.init.method === "POST" &&
    item.url.pathname.endsWith(`/channels/${ids.aiChannelId}/silence`)
  ));
  await adapter.stopSilence(ids.aiChannelId);
  assert.ok(requests.some((item) =>
    item.init.method === "DELETE" &&
    item.url.pathname.endsWith(`/channels/${ids.aiChannelId}/silence`)
  ));

  const lead = await adapter.originateLead(
    callId,
    "+919876543210",
    "+911140000000",
  );
  const leadRequest = requests.find((item) =>
    item.url.pathname.endsWith(`/channels/${ids.leadChannelId}`)
  );
  assert.equal(
    leadRequest?.url.searchParams.get("endpoint"),
    "PJSIP/+919876543210@zadarma",
  );
  assert.equal(leadRequest?.url.searchParams.get("callerId"), "+911140000000");
  sockets.socket!.event({
    type: "ChannelDestroyed",
    cause: 17,
    cause_txt: "User busy",
    channel: { id: ids.leadChannelId, state: "Down" },
  });
  await assert.rejects(lead.answered, /busy/);

  const noAnswerLead = await adapter.originateLead(
    callId,
    "+919876543210",
    "+911140000000",
  );
  sockets.socket!.event({
    type: "ChannelDestroyed",
    cause: 19,
    cause_txt: "No answer from user",
    channel: { id: ids.leadChannelId, state: "Down" },
  });
  await assert.rejects(noAnswerLead.answered, /no-answer/);

  const defaultCallerIdLead = await adapter.originateLead(
    callId,
    "+919876543210",
  );
  const defaultCallerIdRequest = requests.filter((item) =>
    item.url.pathname.endsWith(`/channels/${ids.leadChannelId}`)
  ).at(-1);
  assert.equal(defaultCallerIdRequest?.url.searchParams.has("callerId"), false);
  sockets.socket!.event({
    type: "ChannelDestroyed",
    cause: 17,
    cause_txt: "User busy",
    channel: { id: ids.leadChannelId, state: "Down" },
  });
  await assert.rejects(defaultCallerIdLead.answered, /busy/);

  const bridgeId = await adapter.createBridge(callId);
  assert.equal(bridgeId, ids.bridgeId);
  await adapter.addChannels(bridgeId, [ids.aiChannelId, ids.leadChannelId]);
  const add = requests.find((item) => item.url.pathname.endsWith("/addChannel"));
  assert.equal(
    add?.url.searchParams.get("channel"),
    `${ids.aiChannelId},${ids.leadChannelId}`,
  );
  const bridgeCreate = requests.find((item) =>
    item.url.pathname.endsWith(`/bridges/${ids.bridgeId}`) &&
    item.init.method === "POST"
  );
  assert.equal(bridgeCreate?.url.searchParams.get("type"), "mixing,proxy_media");
  assert.deepEqual(await adapter.negotiatedFormats(ids.aiChannelId), {
    readFormat: "alaw",
    writeFormat: "ulaw",
  });
  await adapter.hangupChannel(ids.aiChannelId);
  await adapter.destroyBridge(ids.bridgeId);
  assert.ok(requests.some((item) =>
    item.init.method === "DELETE" &&
    item.url.pathname.endsWith(`/channels/${ids.aiChannelId}`)
  ));
  assert.ok(requests.some((item) =>
    item.init.method === "DELETE" &&
    item.url.pathname.endsWith(`/bridges/${ids.bridgeId}`)
  ));
  await adapter.close();
});

test("reconciles ambiguous ARI mutations before deciding whether to retry", async () => {
  const callId = "ambiguous-call";
  const ids = asteriskResourceIds(callId);
  const sockets = new FakeEventSocketFactory();
  const fetchFn = (async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/variable")) return json({ value: "sip-ambiguous" });
    if (init.method === "POST" && url.pathname.endsWith(`/channels/${ids.aiChannelId}`)) {
      throw new Error("connection reset after write");
    }
    if (init.method === "GET" && url.pathname.endsWith(`/channels/${ids.aiChannelId}`)) {
      return json({ id: ids.aiChannelId, state: "Down" });
    }
    if (init.method === "POST" && url.pathname.endsWith(`/bridges/${ids.bridgeId}`)) {
      throw new Error("connection reset after write");
    }
    if (init.method === "POST" && url.pathname.endsWith("/addChannel")) {
      throw new Error("connection reset after write");
    }
    if (init.method === "GET" && url.pathname.endsWith(`/bridges/${ids.bridgeId}`)) {
      return json({
        id: ids.bridgeId,
        channels: [ids.aiChannelId, ids.leadChannelId],
      });
    }
    if (init.method === "DELETE" && url.pathname.endsWith(`/channels/${ids.aiChannelId}`)) {
      throw new Error("connection reset after write");
    }
    if (init.method === "GET" && url.pathname.endsWith(`/channels/${ids.aiChannelId}`)) {
      return json({}, 404);
    }
    throw new Error(`Unexpected ARI request ${init.method} ${url}`);
  }) as typeof fetch;
  const adapter = new AsteriskAriAdapter(
    {
      baseUrl: "http://127.0.0.1:8088/ari",
      username: "user",
      password: "password",
      app: "elevatebox",
      zadarmaEndpoint: "zadarma",
      openAIEndpoint: "openai",
      callIdPollIntervalMs: 1,
    },
    { fetchFn, socketFactory: sockets },
  );
  await adapter.start();
  const leg = await adapter.originateOpenAI(callId, "proj_1");
  void leg.answered.catch(() => undefined);
  assert.equal(leg.channelId, ids.aiChannelId);
  assert.equal(await adapter.createBridge(callId), ids.bridgeId);
  await adapter.addChannels(ids.bridgeId, [ids.aiChannelId, ids.leadChannelId]);
  await adapter.close();
});

test("startup cleanup removes only orphaned ElevateBox ARI resources", async () => {
  const deleted: string[] = [];
  const sockets = new FakeEventSocketFactory();
  const fetchFn = (async (input, init = {}) => {
    const url = new URL(String(input));
    if (init.method === "GET" && url.pathname.endsWith("/channels")) {
      return json([
        { id: "elevatebox-old-ai", state: "Up" },
        { id: "operator-unrelated-channel", state: "Up" },
      ]);
    }
    if (init.method === "GET" && url.pathname.endsWith("/bridges")) {
      return json([
        { id: "elevatebox-old-bridge", channels: [] },
        { id: "operator-unrelated-bridge", channels: [] },
      ]);
    }
    if (init.method === "DELETE") {
      deleted.push(url.pathname);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected ARI request ${init.method} ${url}`);
  }) as typeof fetch;
  const adapter = new AsteriskAriAdapter(
    {
      baseUrl: "http://127.0.0.1:8088/ari",
      username: "user",
      password: "password",
      app: "elevatebox",
      zadarmaEndpoint: "zadarma",
      openAIEndpoint: "openai",
    },
    { fetchFn, socketFactory: sockets },
  );
  await adapter.start();
  assert.deepEqual(await adapter.cleanupOrphans(), { channels: 1, bridges: 1 });
  assert.deepEqual(deleted.sort(), [
    "/ari/bridges/elevatebox-old-bridge",
    "/ari/channels/elevatebox-old-ai",
  ]);
  await adapter.close();
});

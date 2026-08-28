import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import WebSocket from "ws";

import type { PreparedCallHandle } from "../src/application/prepared-call-coordinator.ts";
import type {
  OutboundDialAdapter,
  OutboundDialRequest,
  OutboundDialResult,
  SessionContext,
} from "../src/contracts.ts";
import type {
  GatewayLiveConnection,
  LiveGatewayCoordinator,
} from "../src/infrastructure/live-gateway-server.ts";
import { LiveGatewayServer } from "../src/infrastructure/live-gateway-server.ts";
import type { ExotelServerSocket } from "../src/infrastructure/exotel-call-adapter.ts";

class FakeLiveConnection implements GatewayLiveConnection {
  readonly messages: string[] = [];
  readonly firstMessage: Promise<string>;
  closed = false;
  private resolveFirstMessage: ((message: string) => void) | undefined;

  constructor() {
    this.firstMessage = new Promise((resolve) => {
      this.resolveFirstMessage = resolve;
    });
  }

  receive(rawMessage: string): void {
    this.messages.push(rawMessage);
    this.resolveFirstMessage?.(rawMessage);
    this.resolveFirstMessage = undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeGatewayCoordinator implements LiveGatewayCoordinator {
  readonly contexts: SessionContext[] = [];
  readonly attachedTokens: string[] = [];
  readonly abortedTokens: string[] = [];
  readonly live = new FakeLiveConnection();
  readonly expiresAt = new Date(Date.now() + 60_000).toISOString();
  private prepared = false;

  async prepare(context: SessionContext): Promise<PreparedCallHandle> {
    this.contexts.push(context);
    this.prepared = true;
    return {
      token: "prepared-token",
      callId: context.callId,
      expiresAt: this.expiresAt,
    };
  }

  async attach(
    token: string,
    _socket: ExotelServerSocket,
  ): Promise<GatewayLiveConnection> {
    if (!this.prepared || token !== "prepared-token") {
      throw new Error("Prepared call token is invalid or already used");
    }
    this.prepared = false;
    this.attachedTokens.push(token);
    return this.live;
  }

  async abort(token: string): Promise<void> {
    this.abortedTokens.push(token);
    this.prepared = false;
  }
}

class FakeOutboundDialer implements OutboundDialAdapter {
  readonly requests: OutboundDialRequest[] = [];
  result: OutboundDialResult = {
    providerCallId: "provider-call-1",
    status: "in-progress",
    simulated: false,
  };
  failure: Error | undefined;

  async dial(request: OutboundDialRequest): Promise<OutboundDialResult> {
    this.requests.push(request);
    if (this.failure) throw this.failure;
    return this.result;
  }
}

async function startGateway(outboundDialer?: OutboundDialAdapter): Promise<{
  coordinator: FakeGatewayCoordinator;
  gateway: LiveGatewayServer;
  httpBaseUrl: string;
  webSocketBaseUrl: string;
}> {
  const coordinator = new FakeGatewayCoordinator();
  const gateway = new LiveGatewayServer({
    coordinator,
    controlApiToken: "test-control-token-at-least-16",
    publicMediaBaseUrl: "wss://voice.example.com/voice",
    host: "127.0.0.1",
    port: 0,
    mediaBasicAuth: { username: "exotel", password: "media-secret" },
    ...(outboundDialer === undefined ? {} : { outboundDialer }),
  });
  const address = await gateway.listen();
  return {
    coordinator,
    gateway,
    httpBaseUrl: `http://127.0.0.1:${address.port}`,
    webSocketBaseUrl: `ws://127.0.0.1:${address.port}`,
  };
}

test("authenticates preparation and bridges the single-use media socket", async () => {
  const { coordinator, gateway, httpBaseUrl, webSocketBaseUrl } = await startGateway();
  try {
    const health = await fetch(`${httpBaseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const unauthorized = await fetch(`${httpBaseUrl}/calls/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callId: "call-1", promptVersion: "v1" }),
    });
    assert.equal(unauthorized.status, 401);

    const prepared = await fetch(`${httpBaseUrl}/calls/prepare`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-control-token-at-least-16",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        callId: "call-1",
        promptVersion: "v1",
        preferredLanguage: "HI",
        leadContext: { campaign: "apartment-observatories" },
      }),
    });
    assert.equal(prepared.status, 201);
    assert.deepEqual(await prepared.json(), {
      callId: "call-1",
      token: "prepared-token",
      expiresAt: coordinator.expiresAt,
      ready: true,
      provider: "exotel",
    });
    assert.deepEqual(coordinator.contexts, [{
      callId: "call-1",
      promptVersion: "v1",
      preferredLanguage: "HI",
      leadContext: { campaign: "apartment-observatories" },
    }]);

    const client = new WebSocket(`${webSocketBaseUrl}/voice/media/prepared-token`, {
      headers: {
        authorization: `Basic ${Buffer.from("exotel:media-secret").toString("base64")}`,
      },
    });
    await once(client, "open");
    const exotelStart = JSON.stringify({ event: "connected", protocol: "Call" });
    client.send(exotelStart);
    await coordinator.live.firstMessage;
    assert.deepEqual(coordinator.attachedTokens, ["prepared-token"]);
    assert.deepEqual(coordinator.live.messages, [exotelStart]);

    client.close();
    await once(client, "close");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(coordinator.live.closed, true);
  } finally {
    await gateway.close();
  }
});

test("cannot dial before prepare and consumes one READY media URL idempotently", async () => {
  const dialer = new FakeOutboundDialer();
  const { gateway, httpBaseUrl } = await startGateway(dialer);
  const headers = {
    authorization: "Bearer test-control-token-at-least-16",
    "content-type": "application/json",
  };
  try {
    const dialBody = {
      callId: "call-dial",
      token: "prepared-token",
      to: "+919876543210",
      idempotencyKey: "dial-call-dial-once",
    };
    const tooEarly = await fetch(`${httpBaseUrl}/calls/dial`, {
      method: "POST",
      headers,
      body: JSON.stringify(dialBody),
    });
    assert.equal(tooEarly.status, 409);
    assert.equal(dialer.requests.length, 0);

    const prepared = await fetch(`${httpBaseUrl}/calls/prepare`, {
      method: "POST",
      headers,
      body: JSON.stringify({ callId: "call-dial", promptVersion: "v1" }),
    });
    assert.equal(prepared.status, 201);
    const ready = await prepared.json() as Record<string, unknown>;
    assert.equal(ready.ready, true);

    const first = await fetch(`${httpBaseUrl}/calls/dial`, {
      method: "POST",
      headers,
      body: JSON.stringify(dialBody),
    });
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), dialer.result);
    assert.equal(dialer.requests.length, 1);
    assert.equal(dialer.requests[0]?.media.ready, true);
    assert.equal(
      "streamUrl" in dialer.requests[0]!.media
        ? dialer.requests[0]!.media.streamUrl
        : undefined,
      "wss://voice.example.com/voice/media/prepared-token?sample-rate=24000",
    );
    assert.equal("streamUrl" in ready, false, "media URL stays internal");

    const replay = await fetch(`${httpBaseUrl}/calls/dial`, {
      method: "POST",
      headers,
      body: JSON.stringify(dialBody),
    });
    assert.equal(replay.status, 202);
    assert.deepEqual(await replay.json(), dialer.result);
    assert.equal(dialer.requests.length, 1, "idempotent replay cannot redial");

    const secondKey = await fetch(`${httpBaseUrl}/calls/dial`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...dialBody, idempotencyKey: "another-key" }),
    });
    assert.equal(secondKey.status, 409);
    assert.equal(dialer.requests.length, 1);
  } finally {
    await gateway.close();
  }
});

test("aborts prepared media after provider failure", async () => {
  const dialer = new FakeOutboundDialer();
  dialer.failure = new Error("provider failure with sensitive data");
  const { coordinator, gateway, httpBaseUrl } = await startGateway(dialer);
  const headers = {
    authorization: "Bearer test-control-token-at-least-16",
    "content-type": "application/json",
  };
  try {
    const prepared = await fetch(`${httpBaseUrl}/calls/prepare`, {
      method: "POST",
      headers,
      body: JSON.stringify({ callId: "call-failure", promptVersion: "v1" }),
    });
    assert.equal(prepared.status, 201);
    const failed = await fetch(`${httpBaseUrl}/calls/dial`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        callId: "call-failure",
        token: "prepared-token",
        to: "+919876543210",
        idempotencyKey: "failed-once",
      }),
    });
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), {
      error: "Outbound provider did not accept the prepared call",
    });
    assert.deepEqual(coordinator.abortedTokens, ["prepared-token"]);
  } finally {
    await gateway.close();
  }
});

test("rejects malformed preparation input before prewarming a paid session", async () => {
  const { coordinator, gateway, httpBaseUrl } = await startGateway();
  try {
    const response = await fetch(`${httpBaseUrl}/calls/prepare`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-control-token-at-least-16",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        callId: "call-2",
        promptVersion: "v1",
        preferredLanguage: "FR",
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "preferredLanguage is not supported",
    });
    assert.equal(coordinator.contexts.length, 0);
  } finally {
    await gateway.close();
  }
});

test("rejects an unauthenticated media upgrade", async () => {
  const { gateway, webSocketBaseUrl } = await startGateway();
  try {
    const client = new WebSocket(`${webSocketBaseUrl}/voice/media/prepared-token`);
    const [, response] = await once(client, "unexpected-response");
    assert.equal((response as { statusCode: number }).statusCode, 401);
    (response as { resume(): void }).resume();
  } finally {
    await gateway.close();
  }
});

test("aborts an unused prewarmed session when the gateway shuts down", async () => {
  const { coordinator, gateway, httpBaseUrl } = await startGateway();
  const prepared = await fetch(`${httpBaseUrl}/calls/prepare`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-control-token-at-least-16",
      "content-type": "application/json",
    },
    body: JSON.stringify({ callId: "call-unused", promptVersion: "v1" }),
  });
  assert.equal(prepared.status, 201);

  await gateway.close();
  assert.deepEqual(coordinator.abortedTokens, ["prepared-token"]);
});

test("exposes only the signed OpenAI webhook surface for the Zadarma/Asterisk route", async () => {
  const coordinator = new FakeGatewayCoordinator();
  let receivedBody: Buffer | undefined;
  let receivedWebhookId: string | string[] | undefined;
  const gateway = new LiveGatewayServer({
    coordinator,
    provider: "asterisk-sip",
    controlApiToken: "test-control-token-at-least-16",
    openAIWebhookReceiver: {
      async handle(rawBody, headers) {
        receivedBody = rawBody;
        receivedWebhookId = headers["webhook-id"];
        return "processed";
      },
    },
    host: "127.0.0.1",
    port: 0,
  });
  const address = await gateway.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const exactBody = ' {"type":"realtime.call.incoming"}\n';
    const response = await fetch(`${baseUrl}/webhooks/openai/realtime`, {
      method: "POST",
      headers: { "webhook-id": "delivery-raw-1" },
      body: exactBody,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true, duplicate: false });
    assert.equal(receivedBody?.toString("utf8"), exactBody);
    assert.equal(receivedWebhookId, "delivery-raw-1");
  } finally {
    await gateway.close();
  }
});

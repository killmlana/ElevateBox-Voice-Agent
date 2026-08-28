import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenAISipSidebandClosedError,
  OpenAISipSidebandAdapter,
} from "../src/infrastructure/openai-sip-sideband-adapter.ts";
import type {
  RealtimeSocket,
  RealtimeSocketFactory,
  RealtimeSocketHandlers,
} from "../src/infrastructure/openai-realtime-runtime.ts";
import { safeReference } from "../src/infrastructure/sanitized-logger.ts";

class FakeSocket implements RealtimeSocket {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  readonly handlers: RealtimeSocketHandlers;

  constructor(handlers: RealtimeSocketHandlers) {
    this.handlers = handlers;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.handlers.open();
  }
  event(value: Record<string, unknown>): void {
    this.handlers.message(JSON.stringify(value));
  }
  remoteClose(code: number, reason: string): void {
    this.handlers.close(code, reason);
  }
}

class FakeSocketFactory implements RealtimeSocketFactory {
  socket?: FakeSocket;
  url?: string;
  headers?: Readonly<Record<string, string>>;
  connect(options: {
    url: string;
    headers: Readonly<Record<string, string>>;
    handlers: RealtimeSocketHandlers;
  }): RealtimeSocket {
    this.url = options.url;
    this.headers = options.headers;
    this.socket = new FakeSocket(options.handlers);
    return this.socket;
  }
}

test("accepts the SIP call and treats the attached sideband as ready on open", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const sockets = new FakeSocketFactory();
  const adapter = new OpenAISipSidebandAdapter(
    {
      apiKey: "openai-test-key",
      instructions: "Qualify the lead naturally.",
      model: "gpt-realtime-2.1",
      voice: "marin",
      inputTranscriptionModel: "gpt-live-transcribe",
      transcriptionPrompt: "ElevateBox, budget, callback",
      semanticVadEagerness: "high",
      maxOutputTokens: 512,
      reasoningEffort: "low",
      languages: ["EN", "HI", "TE", "MIXED"],
      safetyIdentifier: "safe-lead-hash",
      handshakeTimeoutMs: 1_000,
    },
    sockets,
    (async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(null, { status: 200 });
    }) as typeof fetch,
  );

  const pending = adapter.accept("rtc_call/with spaces", {
    callId: "business-call-1",
    promptVersion: "v1",
    preferredLanguage: "HI",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const socket = sockets.socket;
  assert.ok(socket);
  socket.open();
  const session = await pending;

  assert.equal(
    requestUrl,
    "https://api.openai.com/v1/realtime/calls/rtc_call%2Fwith%20spaces/accept",
  );
  assert.equal(requestInit?.method, "POST");
  assert.equal(
    (requestInit?.headers as Record<string, string>).Authorization,
    "Bearer openai-test-key",
  );
  const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
  assert.equal(body.type, "realtime");
  assert.equal(body.model, "gpt-realtime-2.1");
  assert.equal(body.voice, undefined);
  assert.equal(body.output_modalities instanceof Array, true);
  assert.match(String(body.instructions), /LANGUAGE LOCK.*Hindi/s);
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.deepEqual(body.tracing, {
    workflow_name: "ElevateBox SIP outbound",
    group_id: safeReference("business-call-1"),
  });
  const audio = body.audio as Record<string, unknown>;
  const input = audio.input as Record<string, unknown>;
  assert.deepEqual(input.format, { type: "audio/pcma" });
  assert.deepEqual(input.transcription, {
    model: "gpt-live-transcribe",
    prompt: "ElevateBox, budget, callback",
  });
  assert.deepEqual(input.turn_detection, {
    type: "semantic_vad",
    eagerness: "high",
    create_response: true,
    interrupt_response: true,
  });
  assert.deepEqual(audio.output, {
    format: { type: "audio/pcma" },
    voice: "marin",
  });
  assert.equal(
    sockets.url,
    "wss://api.openai.com/v1/realtime?call_id=rtc_call%2Fwith%20spaces",
  );

  await session.startConversation("Introduce ElevateBox now.");
  assert.equal(socket.sent.at(-1)?.type, "response.create");
  const events = session.events()[Symbol.asyncIterator]();
  assert.equal((await events.next()).value?.type, "session.ready");
  // An attached SIP monitoring socket may omit session.created. If it does
  // arrive, it must not create a second readiness transition.
  socket.event({ type: "session.created", session: { id: "sess-1" } });
  socket.event({ type: "response.created", response: { id: "resp-1" } });
  assert.equal((await events.next()).value?.type, "response.created");
  socket.event({
    type: "response.output_audio.delta",
    response_id: "resp-1",
    delta: "base64-audio-that-is-never-decoded",
  });
  const audioStarted = (await events.next()).value;
  assert.equal(audioStarted?.type, "model.response.started");
  assert.equal("frame" in (audioStarted?.payload ?? {}), false);

  socket.event({ type: "input_audio_buffer.speech_started", item_id: "user-1" });
  assert.equal((await events.next()).value?.type, "user.speech_started");
  assert.equal((await events.next()).value?.type, "sip.response_cancel_sent");
  assert.equal(socket.sent.at(-1)?.type, "response.cancel");
  socket.event({
    type: "response.done",
    response: { id: "resp-1", status: "cancelled" },
  });
  assert.equal((await events.next()).value?.type, "sip.response_cancelled");
  assert.equal((await events.next()).value?.type, "response.done");
  await session.close();
});

test("uses the first audio-transcript delta as the SIP response-start fallback", async () => {
  const sockets = new FakeSocketFactory();
  const adapter = new OpenAISipSidebandAdapter(
    {
      apiKey: "key",
      instructions: "Be concise.",
      model: "gpt-realtime-2.1",
      voice: "marin",
      inputTranscriptionModel: "gpt-live-transcribe",
      reasoningEffort: "low",
      languages: ["EN"],
      handshakeTimeoutMs: 1_000,
    },
    sockets,
    (async () => new Response(null, { status: 200 })) as typeof fetch,
  );
  const sessionPromise = adapter.accept("call-1", {
    callId: "business-call-1",
    promptVersion: "v1",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const socket = sockets.socket!;
  socket.open();
  const session = await sessionPromise;
  const events = session.events()[Symbol.asyncIterator]();
  assert.equal((await events.next()).value?.type, "session.ready");

  socket.event({ type: "response.created", response: { id: "resp-transcript" } });
  assert.equal((await events.next()).value?.type, "response.created");
  socket.event({
    type: "response.output_audio_transcript.delta",
    response_id: "resp-transcript",
    item_id: "item-1",
    delta: "Hello",
  });
  const started = (await events.next()).value;
  assert.equal(started?.type, "model.response.started");
  assert.equal(started?.payload.observedVia, "audio_transcript_delta");
  assert.equal((await events.next()).value?.type, "agent.transcript.delta");

  socket.event({
    type: "response.output_audio_transcript.delta",
    response_id: "resp-transcript",
    item_id: "item-1",
    delta: " again",
  });
  assert.equal((await events.next()).value?.type, "agent.transcript.delta");
  await session.close();
});

test("fails the event iterator when an attached SIP sideband closes after ready", async () => {
  const sockets = new FakeSocketFactory();
  const adapter = new OpenAISipSidebandAdapter(
    {
      apiKey: "key",
      instructions: "Be concise.",
      model: "gpt-realtime-2.1",
      voice: "sage",
      inputTranscriptionModel: "gpt-live-transcribe",
      reasoningEffort: "low",
      languages: ["EN"],
      handshakeTimeoutMs: 1_000,
    },
    sockets,
    (async () => new Response(null, { status: 200 })) as typeof fetch,
  );
  const pending = adapter.accept("call-close", {
    callId: "business-call-close",
    promptVersion: "v1",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const socket = sockets.socket!;
  socket.open();
  const session = await pending;
  const events = session.events()[Symbol.asyncIterator]();
  assert.equal((await events.next()).value?.type, "session.ready");

  socket.remoteClose(1000, "provider shutdown");
  await assert.rejects(events.next(), (error: unknown) => {
    assert.ok(error instanceof OpenAISipSidebandClosedError);
    assert.equal(error.closeCode, 1000);
    assert.equal(error.configured, true);
    assert.equal(error.reasonRef, safeReference("provider shutdown"));
    assert.doesNotMatch(error.message, /provider shutdown/);
    return true;
  });
});

test("reject and hangup use the OpenAI SIP call control endpoints", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new OpenAISipSidebandAdapter(
    {
      apiKey: "key",
      instructions: "Be concise.",
      model: "gpt-realtime-2.1",
      voice: "marin",
      inputTranscriptionModel: null,
      reasoningEffort: "low",
      languages: ["EN"],
      handshakeTimeoutMs: 1_000,
    },
    new FakeSocketFactory(),
    (async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(null, { status: 200 });
    }) as typeof fetch,
  );
  await adapter.reject("call-unknown", 486);
  await adapter.hangup("call-active");
  assert.match(requests[0]!.url, /call-unknown\/reject$/);
  assert.deepEqual(JSON.parse(String(requests[0]!.init?.body)), { status_code: 486 });
  assert.match(requests[1]!.url, /call-active\/hangup$/);
  assert.equal(requests[1]!.init?.body, undefined);
});

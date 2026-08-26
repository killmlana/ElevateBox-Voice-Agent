import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationDirective } from "../src/contracts.ts";
import {
  OpenAIRealtimeRuntime,
  type RealtimeSocket,
  type RealtimeSocketFactory,
  type RealtimeSocketHandlers,
} from "../src/infrastructure/openai-realtime-runtime.ts";

class FakeRealtimeSocket implements RealtimeSocket {
  readonly sent: Record<string, unknown>[] = [];
  readonly handlers: RealtimeSocketHandlers;
  closed = false;

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

  receive(event: Record<string, unknown>): void {
    this.handlers.message(JSON.stringify(event));
  }
}

class FakeRealtimeSocketFactory implements RealtimeSocketFactory {
  socket?: FakeRealtimeSocket;
  url?: string;
  headers?: Readonly<Record<string, string>>;

  connect(options: {
    url: string;
    headers: Readonly<Record<string, string>>;
    handlers: RealtimeSocketHandlers;
  }): RealtimeSocket {
    this.url = options.url;
    this.headers = options.headers;
    this.socket = new FakeRealtimeSocket(options.handlers);
    return this.socket;
  }
}

async function openTestSession() {
  const factory = new FakeRealtimeSocketFactory();
  const runtime = new OpenAIRealtimeRuntime(
    {
      apiKey: "test-key",
      instructions: "Be concise and qualify the lead naturally.",
      safetyIdentifier: "hashed-lead-id",
      languages: ["EN", "HI", "TE", "MIXED"],
      semanticVadEagerness: "high",
    },
    factory,
  );
  const pendingSession = runtime.createSession({
    callId: "call-rt-1",
    promptVersion: "v1",
  });
  const socket = factory.socket;
  assert.ok(socket);
  socket.open();
  socket.receive({ type: "session.created", session: { id: "sess-1" } });
  socket.receive({ type: "session.updated", session: { id: "sess-1" } });
  const session = await pendingSession;
  return { runtime, session, socket, factory };
}

test("configures one direct Realtime WebSocket before declaring the session ready", async () => {
  const { runtime, session, socket, factory } = await openTestSession();

  assert.equal(
    factory.url,
    "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1",
  );
  assert.equal(factory.headers?.Authorization, "Bearer test-key");
  assert.equal(
    factory.headers?.["OpenAI-Safety-Identifier"],
    "hashed-lead-id",
  );
  assert.deepEqual(runtime.capabilities.languages, ["EN", "HI", "TE", "MIXED"]);

  const configure = socket.sent[0];
  assert.equal(configure?.type, "session.update");
  const configuredSession = configure?.session as Record<string, unknown>;
  assert.equal(configuredSession.model, "gpt-realtime-2.1");
  const audio = configuredSession.audio as Record<string, unknown>;
  const input = audio.input as Record<string, unknown>;
  const output = audio.output as Record<string, unknown>;
  assert.deepEqual(input.format, { type: "audio/pcm", rate: 24000 });
  assert.deepEqual(output.format, { type: "audio/pcm", rate: 24000 });
  assert.deepEqual(input.transcription, {
    model: "gpt-live-transcribe",
    languages: ["en", "hi", "te"],
  });
  assert.deepEqual(input.turn_detection, {
    type: "semantic_vad",
    eagerness: "high",
    create_response: true,
    interrupt_response: true,
  });
  assert.equal(configuredSession.max_output_tokens, 512);
  assert.deepEqual(configuredSession.reasoning, { effort: "low" });

  await session.close();
});

test("surfaces an initial session rejection instead of masking it as a timeout", async () => {
  const factory = new FakeRealtimeSocketFactory();
  const runtime = new OpenAIRealtimeRuntime(
    {
      apiKey: "test-key",
      instructions: "Be concise.",
      handshakeTimeoutMs: 5_000,
    },
    factory,
  );
  const pendingSession = runtime.createSession({
    callId: "call-rejected",
    promptVersion: "v1",
  });
  const socket = factory.socket;
  assert.ok(socket);
  socket.open();
  socket.receive({
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "invalid_value",
      message: "Unsupported test session field",
    },
  });

  await assert.rejects(
    pendingSession,
    /session rejected: Unsupported test session field/,
  );
  assert.equal(socket.closed, true);
});

test("normalizes final caller transcripts with committed-turn ordering metadata", async () => {
  const { session, socket } = await openTestSession();
  const events = session.events()[Symbol.asyncIterator]();
  assert.equal((await events.next()).value?.type, "session.created");
  await events.next();

  socket.receive({ type: "input_audio_buffer.committed", item_id: "user-1" });
  assert.equal((await events.next()).value?.type, "input_audio_buffer.committed");
  socket.receive({ type: "input_audio_buffer.committed", item_id: "user-2" });
  await events.next();

  socket.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "user-2",
    transcript: "Second completed first",
    languages: [{ code: "hi" }, { code: "en" }],
  });
  const second = (await events.next()).value;
  assert.equal(second?.type, "user.turn.completed");
  assert.equal(second?.payload.turnSequence, 2);

  socket.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "user-1",
    transcript: "First completed second",
  });
  const first = (await events.next()).value;
  assert.equal(first?.payload.turnSequence, 1);
  assert.equal(first?.payload.turnId, "user-1");
  await session.close();
});

test("streams canonical PCM audio and rejects unconverted telephony audio", async () => {
  const { session, socket } = await openTestSession();
  await session.sendAudio({
    data: new Uint8Array([0, 1, 2, 255]),
    sampleRateHz: 24000,
    encoding: "pcm16",
    timestampMs: 0,
  });
  assert.deepEqual(socket.sent.at(-1), {
    event_id: "audio_000002",
    type: "input_audio_buffer.append",
    audio: "AAEC/w==",
  });

  await assert.rejects(
    session.sendAudio({
      data: new Uint8Array([0]),
      sampleRateHz: 8000,
      encoding: "pcmu",
      timestampMs: 0,
    }),
    /convert in MediaGateway/,
  );
  await session.close();
});

test("can explicitly start an outbound conversation after media is attached", async () => {
  const { session, socket } = await openTestSession();

  await session.startConversation("Introduce yourself and begin the outbound call.");

  assert.deepEqual(socket.sent.at(-1), {
    event_id: "response_000002",
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      instructions: "Introduce yourself and begin the outbound call.",
    },
  });
  await session.close();
});

test("normalizes output audio, speech events, transcripts, and truncation", async () => {
  const { session, socket } = await openTestSession();
  const events = session.events()[Symbol.asyncIterator]();
  assert.equal((await events.next()).value?.type, "session.created");
  assert.equal((await events.next()).value?.type, "session.ready");

  const itemEvent = events.next();
  socket.receive({
    type: "response.output_item.added",
    item: { id: "assistant-item-7", type: "message" },
  });
  assert.equal((await itemEvent).value?.type, "response.output_item.added");

  const audioEvent = events.next();
  socket.receive({
    type: "response.output_audio.delta",
    item_id: "assistant-item-7",
    response_id: "response-3",
    delta: "AQID",
  });
  const normalizedAudio = (await audioEvent).value;
  assert.equal(normalizedAudio?.type, "audio.output.delta");
  const frame = normalizedAudio?.payload.frame as {
    data: Uint8Array;
    sampleRateHz: number;
    encoding: string;
  };
  assert.deepEqual([...frame.data], [1, 2, 3]);
  assert.equal(frame.sampleRateHz, 24000);
  assert.equal(frame.encoding, "pcm16");

  const partialTranscriptEvent = events.next();
  socket.receive({
    type: "response.output_audio_transcript.delta",
    item_id: "assistant-item-7",
    response_id: "response-3",
    delta: "Do you run a business?",
  });
  const partialTranscript = (await partialTranscriptEvent).value;
  assert.equal(partialTranscript?.type, "agent.transcript.delta");
  assert.equal(partialTranscript?.payload.delta, "Do you run a business?");

  const speechEvent = events.next();
  socket.receive({
    type: "input_audio_buffer.speech_started",
    audio_start_ms: 420,
  });
  assert.equal((await speechEvent).value?.type, "user.speech_started");

  await session.interruptOutput(387.6);
  assert.deepEqual(socket.sent.at(-1), {
    event_id: "truncate_000002",
    type: "conversation.item.truncate",
    item_id: "assistant-item-7",
    content_index: 0,
    audio_end_ms: 388,
  });

  const transcriptEvent = events.next();
  socket.receive({
    type: "response.output_audio_transcript.done",
    transcript: "I can help with that.",
    item_id: "assistant-item-7",
  });
  const normalizedTranscript = (await transcriptEvent).value;
  assert.equal(normalizedTranscript?.type, "agent.turn.completed");
  assert.equal(
    normalizedTranscript?.payload.transcript,
    "I can help with that.",
  );
  await session.close();
});

test("applies supervisor directives through session instructions without blocking audio", async () => {
  const { session, socket } = await openTestSession();
  const directive: ConversationDirective = {
    directiveId: "directive-1",
    callId: "call-rt-1",
    intent: "CONFIRM_ACTION_SUCCESS",
    priority: 2,
    delivery: "NEXT_NATURAL_TURN",
    data: { action: "WhatsApp details" },
  };

  await session.setPreferredLanguage("HI");
  const languageUpdate = socket.sent.at(-1);
  assert.equal(languageUpdate?.type, "session.update");
  assert.match(
    String((languageUpdate?.session as Record<string, unknown>).instructions),
    /LANGUAGE LOCK.*Hindi/i,
  );

  await session.sendDirective(directive);
  const event = socket.sent.at(-1);
  assert.equal(event?.type, "session.update");
  const update = event?.session as Record<string, unknown>;
  assert.match(String(update.instructions), /external action has succeeded/i);
  assert.match(String(update.instructions), /WhatsApp details/);
  assert.match(String(update.instructions), /LANGUAGE LOCK.*Hindi/i);

  await session.close();
});

test("tells the model that fake action completion is only a local dry run", async () => {
  const { session, socket } = await openTestSession();
  await session.sendDirective({
    directiveId: "directive-dry-run",
    callId: "call-rt-1",
    intent: "CONFIRM_ACTION_SUCCESS",
    priority: 2,
    delivery: "NEXT_NATURAL_TURN",
    data: { kind: "SEND_HOT_DETAILS", simulated: true },
  });

  const update = socket.sent.at(-1)?.session as Record<string, unknown>;
  assert.match(String(update.instructions), /LOCAL DRY RUN ONLY/);
  assert.match(String(update.instructions), /no real message/i);
  assert.doesNotMatch(String(update.instructions), /external action has succeeded/i);
  await session.close();
});

test("queues an immediate action result until the active Realtime response completes", async () => {
  const { session, socket } = await openTestSession();
  socket.receive({ type: "response.created", response: { id: "resp-1" } });
  await session.sendDirective({
    directiveId: "directive-immediate",
    callId: "call-rt-1",
    intent: "CONFIRM_ACTION_SUCCESS",
    priority: 2,
    delivery: "IMMEDIATE_IF_IDLE",
    data: { kind: "SEND_HOT_DETAILS" },
  });
  assert.equal(socket.sent.at(-1)?.type, "session.update", "result must not interrupt an active response");

  socket.receive({ type: "response.done", response: { id: "resp-1", status: "completed" } });
  const result = socket.sent.at(-1);
  assert.equal(result?.type, "response.create");
  const response = result?.response as Record<string, unknown>;
  assert.deepEqual(response.output_modalities, ["audio"]);
  assert.match(String(response.instructions), /send ho gaya/i);
  assert.match(String(response.instructions), /Do not recap/i);
  await session.close();
});

test("continues a response that reports max-output truncation once", async () => {
  const { session, socket } = await openTestSession();
  socket.receive({ type: "response.created", response: { id: "resp-long" } });
  socket.receive({
    type: "response.done",
    response: {
      id: "resp-long",
      status: "incomplete",
      status_details: { reason: "max_output_tokens" },
    },
  });
  const continuation = socket.sent.at(-1);
  assert.equal(continuation?.type, "response.create");
  assert.match(
    String((continuation?.response as Record<string, unknown>).instructions),
    /exactly where it stopped/i,
  );
  socket.receive({
    type: "response.done",
    response: {
      id: "resp-long-continued",
      status: "incomplete",
      status_details: { reason: "max_output_tokens" },
    },
  });
  assert.equal(
    socket.sent.filter((event) => event.type === "response.create").length,
    1,
  );
  await session.close();
});

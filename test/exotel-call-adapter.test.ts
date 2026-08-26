import assert from "node:assert/strict";
import test from "node:test";

import type {
  AudioFrame,
  ConversationDirective,
  ConversationSessionPort,
  VoiceRuntimeEvent,
} from "../src/contracts.ts";
import {
  ExotelCallAdapter,
  type ExotelServerSocket,
} from "../src/infrastructure/exotel-call-adapter.ts";

class QuietEventStream implements AsyncIterableIterator<VoiceRuntimeEvent> {
  private waiter?: (value: IteratorResult<VoiceRuntimeEvent>) => void;
  private ended = false;

  [Symbol.asyncIterator](): AsyncIterableIterator<VoiceRuntimeEvent> {
    return this;
  }

  next(): Promise<IteratorResult<VoiceRuntimeEvent>> {
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  end(): void {
    this.ended = true;
    this.waiter?.({ value: undefined, done: true });
  }
}

class FakeConversationSession implements ConversationSessionPort {
  readonly audio: AudioFrame[] = [];
  readonly interruptions: number[] = [];
  readonly stream = new QuietEventStream();

  async startConversation(_instruction?: string): Promise<void> {}
  async setPreferredLanguage(_language: import("../src/contracts.ts").SupportedLanguage): Promise<void> {}
  async sendAudio(frame: AudioFrame): Promise<void> {
    this.audio.push(frame);
  }

  async sendDirective(_directive: ConversationDirective): Promise<void> {}

  async interruptOutput(playedAudioMs: number): Promise<void> {
    this.interruptions.push(playedAudioMs);
  }

  events(): AsyncIterable<VoiceRuntimeEvent> {
    return this.stream;
  }

  async close(): Promise<void> {
    this.stream.end();
  }
}

class FakeExotelSocket implements ExotelServerSocket {
  readonly sent: Record<string, unknown>[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
}

function startEvent(sampleRate = "24000"): string {
  return JSON.stringify({
    event: "start",
    sequence_number: "1",
    stream_sid: "MZ-test-stream",
    start: {
      stream_sid: "MZ-test-stream",
      call_sid: "CA-test-call",
      media_format: {
        encoding: "audio/x-raw",
        sample_rate: sampleRate,
        bit_rate: "16",
      },
    },
  });
}

test("passes Exotel 24 kHz linear16 input to Realtime without transcoding", async () => {
  const socket = new FakeExotelSocket();
  const conversation = new FakeConversationSession();
  const adapter = new ExotelCallAdapter(socket, conversation);
  adapter.receive(startEvent());
  adapter.receive(
    JSON.stringify({
      event: "media",
      stream_sid: "MZ-test-stream",
      media: { timestamp: "200", payload: "AAEC/w==" },
    }),
  );
  await adapter.idle();

  assert.equal(conversation.audio.length, 1);
  assert.deepEqual([...conversation.audio[0]!.data], [0, 1, 2, 255]);
  assert.equal(conversation.audio[0]!.encoding, "pcm16");
  assert.equal(conversation.audio[0]!.sampleRateHz, 24000);
  assert.equal(conversation.audio[0]!.timestampMs, 200);
  await adapter.close();
});

test("rejects a non-canonical Exotel stream instead of adding live resampling", async () => {
  const adapter = new ExotelCallAdapter(
    new FakeExotelSocket(),
    new FakeConversationSession(),
  );
  adapter.receive(startEvent("8000"));
  await assert.rejects(adapter.idle(), /24000 Hz to avoid transcoding/);
  await adapter.close();
});

test("meets Exotel chunk limits, marks playback, and clears before truncation", async () => {
  const socket = new FakeExotelSocket();
  const conversation = new FakeConversationSession();
  const adapter = new ExotelCallAdapter(socket, conversation);
  adapter.receive(startEvent());
  await adapter.idle();

  await adapter.handleRuntimeEvent({
    type: "audio.output.delta",
    payload: {
      itemId: "assistant-item-1",
      frame: {
        data: new Uint8Array(4000).fill(7),
        sampleRateHz: 24000,
        encoding: "pcm16",
        timestampMs: 0,
      } satisfies AudioFrame,
    },
  });
  assert.equal(socket.sent.length, 2, "one media event and one playback mark");
  const firstMedia = socket.sent[0]!;
  assert.equal(firstMedia.event, "media");
  const firstPayload = (firstMedia.media as Record<string, unknown>).payload;
  assert.equal(atob(String(firstPayload)).length, 3200);

  await adapter.handleRuntimeEvent({ type: "response.done", payload: {} });
  assert.equal(socket.sent.length, 4, "trailing PCM is padded and flushed");
  const trailingPayload = (
    socket.sent[2]!.media as Record<string, unknown>
  ).payload;
  assert.equal(atob(String(trailingPayload)).length, 3200);

  adapter.receive(
    JSON.stringify({
      event: "mark",
      stream_sid: "MZ-test-stream",
      mark: { name: "rt-1" },
    }),
  );
  await adapter.idle();
  await adapter.handleRuntimeEvent({
    type: "user.speech_started",
    payload: { audioStartMs: 500 },
  });

  assert.equal(socket.sent.at(-1)?.event, "clear");
  assert.equal(conversation.interruptions.length, 1);
  assert.ok(
    Math.abs(conversation.interruptions[0]! - 66.6667) < 0.01,
    "truncate at the last Exotel-confirmed playback mark",
  );
  await adapter.close();
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  LiveCallCoordinator,
} from "../src/application/live-call-controller.ts";
import { PrototypeSystem } from "../src/application/prototype-system.ts";
import type {
  AudioFrame,
  ConversationDirective,
  ConversationRuntime,
  ConversationSessionPort,
  VoiceRuntimeEvent,
} from "../src/contracts.ts";
import { FixedClock } from "../src/infrastructure/clock.ts";
import {
  FakeMessagingAdapter,
  FakeSchedulerAdapter,
} from "../src/infrastructure/fake-adapters.ts";
import { ScriptedLeadUnderstandingAdapter } from "../src/infrastructure/scripted-understanding.ts";

interface PendingEvent {
  resolve(value: IteratorResult<VoiceRuntimeEvent>): void;
}

class PushEventStream implements AsyncIterableIterator<VoiceRuntimeEvent> {
  private readonly queued: VoiceRuntimeEvent[] = [];
  private readonly waiters: PendingEvent[] = [];
  private ended = false;

  [Symbol.asyncIterator](): AsyncIterableIterator<VoiceRuntimeEvent> {
    return this;
  }

  next(): Promise<IteratorResult<VoiceRuntimeEvent>> {
    const value = this.queued.shift();
    if (value) return Promise.resolve({ value, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push({ resolve }));
  }

  push(value: VoiceRuntimeEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.queued.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }
}

class IntegratedFakeSession implements ConversationSessionPort {
  readonly stream = new PushEventStream();
  readonly directives: ConversationDirective[] = [];
  closed = false;

  async startConversation(_instruction?: string): Promise<void> {}
  async setPreferredLanguage(_language: import("../src/contracts.ts").SupportedLanguage): Promise<void> {}
  async sendAudio(_frame: AudioFrame): Promise<void> {}
  async sendDirective(directive: ConversationDirective): Promise<void> {
    this.directives.push(directive);
  }
  async interruptOutput(_playedAudioMs: number): Promise<void> {}
  events(): AsyncIterable<VoiceRuntimeEvent> {
    return this.stream;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.stream.end();
  }
}

test("runs an ordered transcript-to-supervisor-to-directive call lifecycle", async () => {
  const clock = new FixedClock("2026-08-26T10:00:00.000Z");
  const messaging = new FakeMessagingAdapter();
  const scheduler = new FakeSchedulerAdapter();
  const system = new PrototypeSystem(
    {
      leadPhone: "+918688664337",
      candidate: {
        candidatePhone: "+919999999999",
        resumeUrl: "resume.pdf",
        architectureUrl: "architecture.png",
      },
    },
    clock,
    messaging,
    scheduler,
    new ScriptedLeadUnderstandingAdapter({
      "user-item-1": {
        language: "EN",
        businessDescription: "mobile observatories for apartment communities",
        budgetInr: 100_000,
        timeline: "this week",
        requirements: ["resident booking slots", "weather rescheduling"],
        buyingSignals: ["clear_need", "start_soon", "send_details"],
      },
      "user-item-2": { callbackPhrase: "tomorrow morning" },
    }),
  );
  const session = new IntegratedFakeSession();
  let monotonicMs = 100;
  const runtime: ConversationRuntime = {
    capabilities: {
      bargeIn: true,
      serverVad: true,
      nativeAudio: true,
      languages: ["EN", "HI", "TE", "MIXED"],
    },
    async createSession() {
      monotonicMs = 125;
      return session;
    },
  };
  const coordinator = new LiveCallCoordinator(runtime, system, {
    tokenFactory: () => "live-token",
    monotonicNow: () => monotonicMs,
    wallNow: () => new Date("2026-08-26T10:00:00.000Z"),
  });
  const prepared = await coordinator.prepare({
    callId: "integrated-call",
    promptVersion: "v1",
  });
  const socketMessages: Record<string, unknown>[] = [];
  const live = await coordinator.attach(prepared.token, {
    send(data) {
      socketMessages.push(JSON.parse(data) as Record<string, unknown>);
    },
  });
  live.receive(JSON.stringify({
    event: "start",
    stream_sid: "MZ-live",
    start: {
      stream_sid: "MZ-live",
      call_sid: "CA-live",
      media_format: {
        encoding: "audio/x-raw",
        sample_rate: "24000",
        bit_rate: "16",
      },
    },
  }));
  await live.adapter.idle();

  session.stream.push({
    type: "agent.turn.completed",
    payload: {
      transcript: "Do you run a business, and what do you sell?",
      itemId: "assistant-opening",
    },
  });
  session.stream.push({
    type: "user.speech_started",
    payload: { item_id: "user-item-1", audio_start_ms: 100 },
  });
  session.stream.push({
    type: "user.turn.completed",
    payload: {
      turnId: "user-item-2",
      turnSequence: 2,
      transcript: "Please call me back tomorrow morning.",
      languages: [{ code: "en" }],
    },
  });
  session.stream.push({
    type: "user.turn.completed",
    payload: {
      turnId: "user-item-1",
      turnSequence: 1,
      transcript: "We run mobile observatories and want to start this week.",
      languages: [{ code: "en" }],
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await live.idle();

  const turnOrder = system
    .eventsFor("integrated-call")
    .filter((event) => event.type === "turn.completed")
    .map((event) => event.sourceTurnIds[0]);
  assert.deepEqual(turnOrder, ["user-item-1", "user-item-2"]);
  const firstTurn = system
    .eventsFor("integrated-call")
    .find((event) =>
      event.type === "turn.completed" && event.sourceTurnIds[0] === "user-item-1"
    );
  assert.equal(
    (firstTurn?.payload as { precedingAssistantText?: string }).precedingAssistantText,
    "Do you run a business, and what do you sell?",
  );
  assert.equal(messaging.deliveries.length, 1);
  assert.equal(scheduler.bookings.length, 1);
  assert.ok(
    session.directives.some(
      (directive) =>
        directive.intent === "INTENT_UPDATED" && directive.data.intent === "HOT",
    ),
  );
  assert.equal(
    live.latency.measurements()[0]?.name,
    "realtime_prewarm_ms",
  );
  assert.equal(live.latency.measurements()[0]?.valueMs, 25);

  live.receive(JSON.stringify({
    event: "stop",
    stream_sid: "MZ-live",
    stop: { reason: "callended" },
  }));
  await live.idle();
  assert.equal(session.closed, true);
  assert.equal(messaging.deliveries.length, 1, "HOT WhatsApp is not duplicated after stop");
  assert.deepEqual(messaging.deliveries[0]?.attachments, ["resume.pdf", "architecture.png"]);
  assert.ok(
    system.eventsFor("integrated-call").some((event) => event.type === "call.ended"),
  );
  assert.equal(
    socketMessages.filter((message) => message.event === "media").length,
    0,
    "no synthetic telephony audio was sent",
  );
});

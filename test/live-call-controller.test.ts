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
  readonly starts: Array<string | undefined> = [];
  readonly selectedLanguages: import("../src/contracts.ts").SupportedLanguage[] = [];
  closed = false;

  async startConversation(instruction?: string): Promise<void> {
    this.starts.push(instruction);
  }
  async setPreferredLanguage(language: import("../src/contracts.ts").SupportedLanguage): Promise<void> {
    this.selectedLanguages.push(language);
  }
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
      "user-item-3": { language: "TE" },
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
    openingInstruction: "Introduce ElevateBox and wait for the lead.",
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
  await live.controller.idle();
  assert.deepEqual(session.starts, [
    "Introduce ElevateBox and wait for the lead.",
  ]);

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
    type: "agent.turn.completed",
    payload: {
      transcript: "Which language are you comfortable with: Hindi, Telugu, or English?",
      itemId: "assistant-language-question",
    },
  });
  session.stream.push({
    type: "user.speech_started",
    payload: { item_id: "user-item-3", audio_start_ms: 300 },
  });
  session.stream.push({
    type: "user.turn.completed",
    payload: {
      turnId: "user-item-3",
      turnSequence: 3,
      transcript: "I am comfortable with Telugu.",
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
  assert.deepEqual(turnOrder, ["user-item-1", "user-item-2", "user-item-3"]);
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
  // The first two turns are both detected as English, which settles detection
  // and locks the model to EN; the third turn explicitly asks for Telugu, which
  // outranks detection and re-locks to TE.
  assert.deepEqual(session.selectedLanguages, ["EN", "TE"]);
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
  assert.deepEqual(messaging.deliveries[0]?.attachments, ["resume.pdf"]);
  assert.ok(
    system.eventsFor("integrated-call").some((event) => event.type === "call.ended"),
  );
  assert.equal(
    socketMessages.filter((message) => message.event === "media").length,
    0,
    "no synthetic telephony audio was sent",
  );
});

// Regression: the detected language was recorded in lead state but never pushed
// to the model. languageLockInstruction is only injected when the caller sets
// preferredLanguage up front, and setPreferredLanguage only fired on an explicit
// "speak Hindi" request - so on a normal call the model carried no language
// constraint at all and drifted between Hindi and English mid-conversation.
// Once detection settles on one supported language we now tell the model.
test("pushes the detected language to the model once detection settles", async () => {
  const system = new PrototypeSystem(
    {
      leadPhone: "+919876543210",
      candidate: { candidatePhone: "+911140000000", resumeUrl: "resume.pdf" },
    },
    new FixedClock("2026-08-26T10:00:00.000Z"),
    new FakeMessagingAdapter(),
    new FakeSchedulerAdapter(),
    new ScriptedLeadUnderstandingAdapter({}),
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
    openingInstruction: "Introduce ElevateBox and wait for the lead.",
  });
  const prepared = await coordinator.prepare({
    callId: "language-settle-call",
    promptVersion: "v1",
  });
  const live = await coordinator.attach(prepared.token, { send() {} });
  live.receive(JSON.stringify({
    event: "start",
    stream_sid: "MZ-lang",
    start: {
      stream_sid: "MZ-lang",
      call_sid: "CA-lang",
      media_format: { encoding: "audio/x-raw", sample_rate: "24000", bit_rate: "16" },
    },
  }));
  await live.adapter.idle();
  await live.controller.idle();

  const speak = (turnId: string, sequence: number, code: string) => {
    session.stream.push({
      type: "user.turn.completed",
      payload: {
        turnId,
        turnSequence: sequence,
        transcript: `turn ${sequence}`,
        languages: [{ code }],
      },
    });
  };

  // One Hindi turn alone must not push: a single detection is not "settled".
  speak("hi-turn-1", 1, "hi");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await live.controller.idle();
  assert.deepEqual(
    session.selectedLanguages,
    [],
    "a single detected turn must not lock the model's language",
  );

  // A second consecutive Hindi turn settles it.
  speak("hi-turn-2", 2, "hi");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await live.controller.idle();
  assert.deepEqual(session.selectedLanguages, ["HI"]);

  // Further Hindi turns must not re-push the same language.
  speak("hi-turn-3", 3, "hi");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await live.controller.idle();
  assert.deepEqual(session.selectedLanguages, ["HI"]);

  await session.close();
});

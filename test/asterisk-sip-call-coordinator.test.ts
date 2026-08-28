import assert from "node:assert/strict";
import test from "node:test";

import { AsteriskSipCallCoordinator } from "../src/application/asterisk-sip-call-coordinator.ts";
import { PrototypeSystem } from "../src/application/prototype-system.ts";
import type {
  ConversationControlSessionPort,
  OutboundDialRequest,
  SessionContext,
  SupportedLanguage,
  TelephonyLifecycleObserver,
  VoiceRuntimeEvent,
} from "../src/contracts.ts";
import { FixedClock } from "../src/infrastructure/clock.ts";
import type {
  AsteriskControlPort,
  AsteriskNegotiatedFormats,
  AsteriskOriginatedLeg,
} from "../src/infrastructure/asterisk-ari-adapter.ts";
import { FakeMessagingAdapter, FakeSchedulerAdapter } from "../src/infrastructure/fake-adapters.ts";
import type { OpenAISipControlPort } from "../src/infrastructure/openai-sip-sideband-adapter.ts";
import { OpenAISipSidebandClosedError } from "../src/infrastructure/openai-sip-sideband-adapter.ts";
import type { OpenAIIncomingSipWebhook } from "../src/infrastructure/openai-webhook-receiver.ts";
import type {
  SafeLogValue,
  SanitizedLogger,
} from "../src/infrastructure/sanitized-logger.ts";
import { ScriptedLeadUnderstandingAdapter } from "../src/infrastructure/scripted-understanding.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class FakeControlSession implements ConversationControlSessionPort {
  readonly starts: Array<string | undefined> = [];
  readonly directives: unknown[] = [];
  closed = false;
  private readonly ended = deferred<void>();

  async startConversation(instruction?: string): Promise<void> {
    this.starts.push(instruction);
  }
  async setPreferredLanguage(_language: SupportedLanguage): Promise<void> {}
  async sendDirective(directive: unknown): Promise<void> {
    this.directives.push(directive);
  }
  async cancelOutput(): Promise<void> {}
  async *events(): AsyncIterable<VoiceRuntimeEvent> {
    await this.ended.promise;
  }
  /**
   * Ends the event stream the way a server-side WebSocket close does: the
   * iterator completes normally, without an error and without us closing the
   * session. Nothing here throws, which is exactly why the drop used to be
   * invisible.
   */
  endStream(): void {
    this.ended.resolve();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ended.resolve();
  }
  fail(error: unknown): void {
    this.ended.reject(error);
  }
}

class CapturingLogger implements SanitizedLogger {
  readonly entries: Array<{
    level: "info" | "warn" | "error";
    event: string;
    fields?: Readonly<Record<string, SafeLogValue>>;
  }> = [];
  info(event: string, fields?: Readonly<Record<string, SafeLogValue>>): void {
    this.entries.push({ level: "info", event, fields });
  }
  warn(event: string, fields?: Readonly<Record<string, SafeLogValue>>): void {
    this.entries.push({ level: "warn", event, fields });
  }
  error(event: string, fields?: Readonly<Record<string, SafeLogValue>>): void {
    this.entries.push({ level: "error", event, fields });
  }
}

class FakeAsterisk implements AsteriskControlPort {
  readonly actions: string[] = [];
  readonly aiAnswered = deferred<void>();
  readonly leadAnswered = deferred<void>();
  readonly hungUpSipCallIds: string[] = [];
  observer?: TelephonyLifecycleObserver;
  leadOriginations = 0;
  openAIOriginateGate?: Deferred<void>;

  async start(): Promise<void> {
    this.actions.push("ari.start");
  }
  async cleanupOrphans(): Promise<{ channels: number; bridges: number }> {
    this.actions.push("ari.cleanup");
    return { channels: 0, bridges: 0 };
  }
  async originateOpenAI(callId: string, projectId: string): Promise<AsteriskOriginatedLeg> {
    this.actions.push(`openai.originate:${callId}:${projectId}`);
    await this.openAIOriginateGate?.promise;
    return {
      channelId: "elevatebox-ai",
      sipCallId: "asterisk-sip-call-id",
      answered: this.aiAnswered.promise,
    };
  }
  async originateLead(callId: string, to: string, callerId?: string): Promise<AsteriskOriginatedLeg> {
    this.leadOriginations += 1;
    this.actions.push(`zadarma.originate:${callId}:${to}:${callerId ?? "default"}`);
    return { channelId: "elevatebox-lead", answered: this.leadAnswered.promise };
  }
  async startSilence(channelId: string): Promise<void> {
    this.actions.push(`channel.silence.start:${channelId}`);
  }
  async stopSilence(channelId: string): Promise<void> {
    this.actions.push(`channel.silence.stop:${channelId}`);
  }
  async createBridge(callId: string): Promise<string> {
    this.actions.push(`bridge.create:${callId}`);
    return "elevatebox-bridge";
  }
  async addChannels(bridgeId: string, channelIds: readonly string[]): Promise<void> {
    this.actions.push(`bridge.add:${bridgeId}:${channelIds.join(",")}`);
  }
  async hangupChannel(channelId: string): Promise<void> {
    this.actions.push(`channel.hangup:${channelId}`);
  }
  async destroyBridge(bridgeId: string): Promise<void> {
    this.actions.push(`bridge.destroy:${bridgeId}`);
  }
  async hangupBySipCallId(sipCallId: string): Promise<number> {
    this.hungUpSipCallIds.push(sipCallId);
    return 1;
  }
  async negotiatedFormats(_channelId: string): Promise<AsteriskNegotiatedFormats> {
    return { readFormat: "alaw", writeFormat: "alaw" };
  }
  subscribe(observer: TelephonyLifecycleObserver): () => void {
    this.observer = observer;
    return () => {
      this.observer = undefined;
    };
  }
  async close(): Promise<void> {
    this.actions.push("ari.close");
  }
}

class FakeOpenAI implements OpenAISipControlPort {
  readonly session = new FakeControlSession();
  readonly accepted: string[] = [];
  readonly rejected: Array<{ callId: string; statusCode?: number }> = [];
  readonly hungUp: string[] = [];

  async accept(callId: string, _context: SessionContext): Promise<ConversationControlSessionPort> {
    this.accepted.push(callId);
    return this.session;
  }
  async reject(callId: string, statusCode?: number): Promise<void> {
    this.rejected.push({ callId, statusCode });
  }
  async hangup(callId: string): Promise<void> {
    this.hungUp.push(callId);
  }
}

function system(): PrototypeSystem {
  return new PrototypeSystem(
    {
      leadPhone: "+919876543210",
      candidate: {
        candidatePhone: "+911140000000",
        resumeUrl: "resume.pdf",
      },
    },
    new FixedClock("2026-08-27T10:00:00.000Z"),
    new FakeMessagingAdapter(),
    new FakeSchedulerAdapter(),
    new ScriptedLeadUnderstandingAdapter({}),
  );
}

function incoming(callId = "openai-call-1", sipCallId = "asterisk-sip-call-id"): OpenAIIncomingSipWebhook {
  return {
    id: `event-${callId}`,
    type: "realtime.call.incoming",
    createdAt: 1_777_000_000,
    callId,
    sipHeaders: [{ name: "Call-ID", value: sipCallId }],
  };
}

test("makes Zadarma the PSTN leg only after OpenAI SIP is AI_READY", async () => {
  const asterisk = new FakeAsterisk();
  const openAI = new FakeOpenAI();
  const workflows = system();
  const coordinator = new AsteriskSipCallCoordinator(
    asterisk,
    openAI,
    workflows,
    {
      projectId: "proj_elevatebox",
      tokenFactory: () => "one-use-ready-token",
      wallNow: () => new Date("2026-08-27T10:00:00.000Z"),
      openingInstruction: "Introduce ElevateBox only after the bridge is live.",
    },
  );
  await coordinator.start();

  const preparedPromise = coordinator.prepare({
    callId: "zadarma-primary-call",
    promptVersion: "elevatebox-v1",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(coordinator.stateFor("zadarma-primary-call"), "PREPARING_AI");
  assert.equal(asterisk.leadOriginations, 0, "Zadarma must not ring during AI preparation");
  await assert.rejects(
    coordinator.dial({
      idempotencyKey: "too-early",
      to: "+919876543210",
      media: {
        ready: true,
        callId: "zadarma-primary-call",
        token: "one-use-ready-token",
        expiresAt: "2026-08-27T10:01:00.000Z",
        provider: "asterisk-sip",
      },
    }),
    /AI_READY/,
  );
  assert.equal(asterisk.leadOriginations, 0);

  const webhookPromise = coordinator.handleIncomingCall(incoming());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(openAI.accepted, ["openai-call-1"]);
  assert.equal(asterisk.leadOriginations, 0);
  asterisk.aiAnswered.resolve();
  await webhookPromise;
  const prepared = await preparedPromise;
  assert.equal(prepared.provider, "asterisk-sip");
  assert.equal(coordinator.stateFor("zadarma-primary-call"), "AI_READY");

  await assert.rejects(
    coordinator.prepare({ callId: "second-call", promptVersion: "v1" }),
    /Only one preparing or active SIP call/,
  );
  await coordinator.handleIncomingCall(incoming("unknown-openai", "unknown-sip-id"));
  assert.deepEqual(openAI.rejected.at(-1), {
    callId: "unknown-openai",
    statusCode: 603,
  });
  assert.deepEqual(asterisk.hungUpSipCallIds, ["unknown-sip-id"]);

  const request: OutboundDialRequest = {
    idempotencyKey: "zadarma-attempt-1",
    to: "+919876543210",
    media: prepared,
  };
  const firstDial = coordinator.dial(request);
  const repeatedDial = coordinator.dial(request);
  assert.equal(firstDial, repeatedDial, "identical retries must share one dial result");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(asterisk.leadOriginations, 1);
  assert.ok(asterisk.actions.indexOf("channel.silence.start:elevatebox-ai") >= 0);
  assert.ok(
    asterisk.actions.indexOf("channel.silence.start:elevatebox-ai") <
      asterisk.actions.indexOf("zadarma.originate:zadarma-primary-call:+919876543210:default"),
  );
  assert.ok(asterisk.actions.includes(
    "zadarma.originate:zadarma-primary-call:+919876543210:default",
  ));
  assert.equal(openAI.session.starts.length, 0, "model must not speak before bridge join");
  asterisk.leadAnswered.resolve();
  const result = await firstDial;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(result, {
    providerCallId: "elevatebox-lead",
    status: "bridged",
    simulated: false,
  });
  assert.equal(coordinator.stateFor("zadarma-primary-call"), "BRIDGED");
  assert.equal(openAI.session.starts.length, 1);
  assert.ok(
    asterisk.actions.indexOf("channel.silence.stop:elevatebox-ai") <
      asterisk.actions.indexOf("bridge.create:zadarma-primary-call"),
  );
  assert.ok(
    asterisk.actions.indexOf("bridge.add:elevatebox-bridge:elevatebox-ai,elevatebox-lead") >= 0,
  );

  await assert.rejects(
    coordinator.dial({ ...request, to: "+919999999999" }),
    /idempotency key was reused/,
  );
  assert.equal(asterisk.leadOriginations, 1);
  await coordinator.close();
  assert.equal(openAI.session.closed, true);
  const latencyEvent = workflows.eventsFor("zadarma-primary-call").find(
    (event) => event.type === "call.latency_summary",
  );
  assert.ok(latencyEvent);
  assert.ok(Array.isArray(
    (latencyEvent.payload as { measurements?: unknown }).measurements,
  ));
});

test("fails and tears down a bridged call when the SIP sideband closes", async () => {
  const asterisk = new FakeAsterisk();
  const openAI = new FakeOpenAI();
  const logger = new CapturingLogger();
  const coordinator = new AsteriskSipCallCoordinator(
    asterisk,
    openAI,
    system(),
    {
      projectId: "proj_elevatebox",
      callerId: "+911140000000",
      tokenFactory: () => "sideband-close-token",
      wallNow: () => new Date("2026-08-27T10:00:00.000Z"),
      openingInstruction: "Introduce ElevateBox after the bridge is live.",
      logger,
    },
  );
  await coordinator.start();

  const preparedPromise = coordinator.prepare({
    callId: "sideband-close-call",
    promptVersion: "v1",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const webhookPromise = coordinator.handleIncomingCall(
    incoming("openai-sideband-close", "asterisk-sip-call-id"),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  asterisk.aiAnswered.resolve();
  await webhookPromise;
  const prepared = await preparedPromise;
  const dialPromise = coordinator.dial({
    idempotencyKey: "sideband-close-attempt",
    to: "+919876543210",
    media: prepared,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  asterisk.leadAnswered.resolve();
  await dialPromise;
  assert.equal(coordinator.stateFor("sideband-close-call"), "BRIDGED");

  openAI.session.fail(
    new OpenAISipSidebandClosedError(1000, "provider shutdown", true),
  );
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (coordinator.stateFor("sideband-close-call") === "FAILED") break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal(coordinator.stateFor("sideband-close-call"), "FAILED");
  assert.ok(asterisk.actions.includes("bridge.destroy:elevatebox-bridge"));
  assert.ok(asterisk.actions.includes("channel.hangup:elevatebox-lead"));
  assert.ok(asterisk.actions.includes("channel.hangup:elevatebox-ai"));
  assert.deepEqual(openAI.hungUp, ["openai-sideband-close"]);
  assert.equal(openAI.session.closed, true);
  const closeLog = logger.entries.find((entry) =>
    entry.event === "openai_sip.sideband_closed"
  );
  assert.ok(closeLog);
  assert.equal(closeLog.fields?.state, "BRIDGED");
  assert.equal(closeLog.fields?.closeCode, 1000);
  assert.equal(closeLog.fields?.cleanCloseCode, true);
  assert.equal(typeof closeLog.fields?.reasonRef, "string");
  assert.ok(logger.entries.some((entry) => entry.event === "sip_call.failed"));
  await coordinator.close();
});

test("expires an unmatched OpenAI preparation and never reaches Zadarma", async () => {
  const asterisk = new FakeAsterisk();
  const openAI = new FakeOpenAI();
  const coordinator = new AsteriskSipCallCoordinator(
    asterisk,
    openAI,
    system(),
    {
      projectId: "proj_elevatebox",
      callerId: "+911140000000",
      tokenFactory: () => "expiring-token",
      ttlMs: 5,
      wallNow: () => new Date("2026-08-27T10:00:00.000Z"),
    },
  );
  await coordinator.start();
  await assert.rejects(
    coordinator.prepare({ callId: "expired-call", promptVersion: "v1" }),
    /expired before reaching READY/,
  );
  assert.equal(coordinator.stateFor("expired-call"), "FAILED");
  assert.equal(asterisk.leadOriginations, 0);
  assert.ok(asterisk.actions.includes("channel.hangup:elevatebox-ai"));

  await coordinator.handleIncomingCall(incoming("late-openai-call"));
  assert.deepEqual(openAI.rejected.at(-1), {
    callId: "late-openai-call",
    statusCode: 603,
  });
  assert.equal(asterisk.leadOriginations, 0);
  await coordinator.close();
});

test("holds an early signed webhook until Asterisk exposes its SIP Call-ID", async () => {
  const asterisk = new FakeAsterisk();
  asterisk.openAIOriginateGate = deferred<void>();
  const openAI = new FakeOpenAI();
  const coordinator = new AsteriskSipCallCoordinator(
    asterisk,
    openAI,
    system(),
    {
      projectId: "proj_elevatebox",
      callerId: "+911140000000",
      tokenFactory: () => "early-webhook-token",
    },
  );
  await coordinator.start();
  const preparedPromise = coordinator.prepare({
    callId: "early-webhook-call",
    promptVersion: "v1",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const webhookPromise = coordinator.handleIncomingCall(incoming());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(openAI.accepted.length, 0);
  assert.equal(openAI.rejected.length, 0);

  asterisk.openAIOriginateGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(openAI.accepted, ["openai-call-1"]);
  asterisk.aiAnswered.resolve();
  await webhookPromise;
  assert.equal((await preparedPromise).provider, "asterisk-sip");
  assert.equal(asterisk.leadOriginations, 0);
  await coordinator.close();
});

// Regression: the OpenAI sideband WebSocket can close AFTER the session is
// configured. handleClose() used to only reject when !configured, so a post-ready
// close merely ended the event queue: forwardEvents' `for await` completed
// normally, its catch never ran, and the call stayed BRIDGED with a dead control
// channel. Observed live as "the AI said one sentence then went silent" - the
// model kept streaming RTP but no turn, VAD or barge-in event ever arrived, and
// nothing was logged, so the failure was invisible in production.
async function bridgedCall(callId: string, logger: CapturingLogger) {
  const asterisk = new FakeAsterisk();
  const openAI = new FakeOpenAI();
  const coordinator = new AsteriskSipCallCoordinator(asterisk, openAI, system(), {
    projectId: "proj_elevatebox",
    tokenFactory: () => "one-use-ready-token",
    wallNow: () => new Date("2026-08-27T10:00:00.000Z"),
    openingInstruction: "Introduce ElevateBox only after the bridge is live.",
    logger,
  });
  await coordinator.start();
  const preparedPromise = coordinator.prepare({ callId, promptVersion: "elevatebox-v1" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const webhookPromise = coordinator.handleIncomingCall(incoming());
  await new Promise<void>((resolve) => setImmediate(resolve));
  asterisk.aiAnswered.resolve();
  await webhookPromise;
  const prepared = await preparedPromise;
  const dial = coordinator.dial({
    idempotencyKey: `${callId}-attempt`,
    to: "+919876543210",
    media: prepared,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  asterisk.leadAnswered.resolve();
  await dial;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(coordinator.stateFor(callId), "BRIDGED");
  return { coordinator, openAI };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("fails a live call when the sideband event stream ends silently", async () => {
  const logger = new CapturingLogger();
  const { coordinator, openAI } = await bridgedCall("sideband-end-call", logger);

  openAI.session.endStream();
  await settle();

  assert.ok(
    logger.entries.some(
      (entry) => entry.event === "openai_sip.sideband_event_stream_ended",
    ),
    `expected sideband_event_stream_ended, saw ${JSON.stringify(logger.entries.map((e) => e.event))}`,
  );
  assert.equal(
    coordinator.stateFor("sideband-end-call"),
    "FAILED",
    "a call with no control channel must not sit bridged and silent",
  );
  await coordinator.close();
});

test("fails a live call when the sideband drops after it was configured", async () => {
  const logger = new CapturingLogger();
  const { coordinator, openAI } = await bridgedCall("sideband-drop-call", logger);

  // What the adapter now raises on a server-side close once configured.
  openAI.session.fail(new OpenAISipSidebandClosedError(1006, "abnormal closure", true));
  await settle();

  assert.equal(
    coordinator.stateFor("sideband-drop-call"),
    "FAILED",
    "a post-ready sideband close must fail the call, not leave it silent",
  );
  await coordinator.close();
});

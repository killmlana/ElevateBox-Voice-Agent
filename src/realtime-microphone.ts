import { spawn, type ChildProcess } from "node:child_process";

import { LiveCallController } from "./application/live-call-controller.ts";
import { LiveCallLatencyRecorder } from "./application/live-call-latency.ts";
import { PrototypeSystem } from "./application/prototype-system.ts";
import type {
  ConversationDirective,
  ConversationSessionPort,
  LeadState,
  NormalizedEvent,
  SupportedLanguage,
} from "./contracts.ts";
import { SystemClock } from "./infrastructure/clock.ts";
import {
  FakeMessagingAdapter,
  FakeSchedulerAdapter,
} from "./infrastructure/fake-adapters.ts";
import { JsonlCallTrace } from "./infrastructure/jsonl-call-trace.ts";
import { ModelLeadUnderstandingAdapter } from "./infrastructure/model-lead-understanding.ts";
import { NodeRealtimeSocketFactory } from "./infrastructure/node-realtime-socket.ts";
import { OpenAIRealtimeRuntime } from "./infrastructure/openai-realtime-runtime.ts";
import { OpenAIResponsesLeadPatchClient } from "./infrastructure/openai-responses-lead-client.ts";
import type { LeadRequestMetrics } from "./infrastructure/openai-responses-lead-client.ts";
import { pacedPcmTargetBytes } from "./infrastructure/pcm-playback-clock.ts";
import {
  ELEVATEBOX_OUTBOUND_PROMPT,
  ELEVATEBOX_OUTBOUND_START,
} from "./prompts/elevatebox-outbound.ts";

const SAMPLE_RATE_HZ = 24_000;
const PCM16_BYTES_PER_SECOND = SAMPLE_RATE_HZ * 2;
const audioMsForBytes = (bytes: number): number =>
  (bytes / PCM16_BYTES_PER_SECOND) * 1000;
const PLAYBACK_CHUNK_MS = 20;
const PLAYBACK_BUFFER_MS = Number(process.env.REALTIME_PLAYBACK_BUFFER_MS ?? 80);
if (
  !Number.isFinite(PLAYBACK_BUFFER_MS) ||
  PLAYBACK_BUFFER_MS < PLAYBACK_CHUNK_MS ||
  PLAYBACK_BUFFER_MS > 250
) {
  throw new Error("REALTIME_PLAYBACK_BUFFER_MS must be between 20 and 250");
}
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set OPENAI_API_KEY before running npm run realtime:mic");
const callId = `mic-${Date.now()}`;
const trace = new JsonlCallTrace(callId, process.env.REALTIME_LOG_DIR ?? "logs");
const showDomainEvents = process.env.REALTIME_SHOW_DOMAIN_EVENTS !== "0";
const speakerDisabled = process.env.REALTIME_NO_SPEAKER === "1";
let lockedLanguage: "HI" | "TE" | "EN" | undefined;

const explicitLanguageSelection = (
  transcript: string,
): "HI" | "TE" | "EN" | undefined => {
  const normalized = transcript.toLowerCase();
  const isSwitchRequest = lockedLanguage === undefined ||
    /switch|speak|बोल|बात|మాట్లాడ|మార్చ/.test(normalized);
  if (!isSwitchRequest) return undefined;
  if (/हिंदी|हिन्दी|\bhindi\b/.test(normalized)) return "HI";
  if (/తెలుగు|\btelugu\b/.test(normalized)) return "TE";
  if (/अंग्रेज|ఇంగ్లీష్|\benglish\b/.test(normalized)) return "EN";
  return undefined;
};

const recordDomainEvent = (event: NormalizedEvent<unknown>): void => {
  trace.recordDomainEvent(event);
  if (!showDomainEvents) return;
  if (event.type === "lead.state.updated" && event.sourceTurnIds.length > 0) {
    const state = (event.payload as { state: LeadState }).state;
    console.log(`[Insights] ${JSON.stringify({
      intent: state.intent,
      score: state.intentScore,
      language: state.language,
      customerType: state.customerType.value,
      locations: state.locations.map((item) => item.value),
      products: state.products.map((item) => item.value),
      budgetInr: state.budgetInr?.value,
      timeline: state.timeline?.value,
      requirements: state.requirements.map((item) => item.value.text),
      blockers: state.blockers.map((item) => item.value),
      negativeSignals: state.negativeSignals.map((item) => item.value),
    })}`);
    return;
  }
  if (event.type === "lead.classification.evaluated") {
    const classification = event.payload as {
      intent: string;
      score: number;
      scoreBreakdown: unknown;
    };
    console.log(
      `[Classification] ${classification.intent} score=${classification.score} ` +
      `${JSON.stringify(classification.scoreBreakdown)}`,
    );
    return;
  }
  if (
    event.type.startsWith("lead.analysis.") ||
    event.type.startsWith("callback.") ||
    event.type.startsWith("action.")
  ) {
    console.log(`[Event] ${event.type} ${JSON.stringify(event.payload)}`);
  }
};

const inputDevice = process.env.REALTIME_MIC_DEVICE ?? "default";
const inputFormat = process.env.REALTIME_MIC_FORMAT ?? "alsa";
const semanticVadEagerness = process.env.OPENAI_SEMANTIC_VAD_EAGERNESS ?? "high";
if (!["low", "medium", "high", "auto"].includes(semanticVadEagerness)) {
  throw new Error(
    "OPENAI_SEMANTIC_VAD_EAGERNESS must be low, medium, high, or auto",
  );
}
const realtimeReasoningEffort = process.env.OPENAI_REALTIME_REASONING_EFFORT ?? "low";
if (!['low', 'medium', 'high'].includes(realtimeReasoningEffort)) {
  throw new Error(
    "OPENAI_REALTIME_REASONING_EFFORT must be low, medium, or high",
  );
}
const realtimeMaxOutputTokensRaw =
  process.env.OPENAI_REALTIME_MAX_OUTPUT_TOKENS?.trim().toLowerCase();
const realtimeMaxOutputTokens: number | "inf" | undefined =
  realtimeMaxOutputTokensRaw === undefined
    ? undefined
    : realtimeMaxOutputTokensRaw === "inf"
      ? "inf"
      : Number(realtimeMaxOutputTokensRaw);
const runtime = new OpenAIRealtimeRuntime(
  {
    apiKey,
    instructions: ELEVATEBOX_OUTBOUND_PROMPT,
    ...(process.env.OPENAI_REALTIME_MODEL
      ? { model: process.env.OPENAI_REALTIME_MODEL }
      : {}),
    ...(process.env.OPENAI_REALTIME_VOICE
      ? { voice: process.env.OPENAI_REALTIME_VOICE }
      : {}),
    inputTranscriptionModel:
      process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-live-transcribe",
    transcriptionPrompt:
      "ElevateBox, e-commerce website development, catalogue, Razorpay, COD, inventory, WhatsApp, budget, products, features, timeline, callback; expect Hindi, Telugu, English, and code-switching.",
    handshakeTimeoutMs: Number(process.env.OPENAI_REALTIME_HANDSHAKE_TIMEOUT_MS ?? 10_000),
    semanticVadEagerness: semanticVadEagerness as "low" | "medium" | "high" | "auto",
    ...(realtimeMaxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: realtimeMaxOutputTokens }),
    reasoningEffort: realtimeReasoningEffort as "low" | "medium" | "high",
    languages: ["EN", "HI", "TE", "MIXED"],
  },
  new NodeRealtimeSocketFactory(),
);

const messaging = new FakeMessagingAdapter();
const scheduler = new FakeSchedulerAdapter();
const leadModel = process.env.OPENAI_LEAD_MODEL ?? "gpt-5.4-nano";
const leadTimeoutMs = Number(process.env.OPENAI_LEAD_TIMEOUT_MS ?? 6_000);
const leadMaxOutputTokens = Number(process.env.OPENAI_LEAD_MAX_OUTPUT_TOKENS ?? 500);
const leadConcurrency = Number(process.env.OPENAI_LEAD_CONCURRENCY ?? 4);
const recordLeadRequestMetrics = (metrics: LeadRequestMetrics): void => {
  trace.record("runtime", "lead.analysis.provider_request", { ...metrics });
  if (showDomainEvents) {
    console.log(
      `[Lead API] ${metrics.status} turn=${metrics.turnId} ` +
      `request=${metrics.requestMs.toFixed(0)}ms queue=${metrics.queueMs.toFixed(0)}ms` +
      (metrics.inputTokens === undefined
        ? ""
        : ` tokens=${metrics.inputTokens}/${metrics.outputTokens ?? "?"}`),
    );
  }
};
const understanding = new ModelLeadUnderstandingAdapter(
  new OpenAIResponsesLeadPatchClient({
    apiKey,
    model: leadModel,
    timeoutMs: leadTimeoutMs,
    maxOutputTokens: leadMaxOutputTokens,
    maxConcurrency: leadConcurrency,
    onRequestMetrics: recordLeadRequestMetrics,
  }),
);
const system = new PrototypeSystem(
  {
    leadPhone: process.env.LEAD_PHONE ?? "+918688664337",
    candidate: {
      candidatePhone:
        process.env.ELEVATEBOX_CONTACT_NUMBER ?? "+91-REPLACE-WITH-YOUR-NUMBER",
      resumeUrl: process.env.ELEVATEBOX_RESUME_PATH ?? "resume.pdf",
      architectureUrl:
        process.env.ELEVATEBOX_BUILD_IMAGE_PATH ?? "architecture.png",
      brochureUrl: process.env.ELEVATEBOX_BROCHURE_PATH ?? "brochure.pdf",
    },
  },
  new SystemClock(),
  messaging,
  scheduler,
  understanding,
  recordDomainEvent,
);

const startedAt = performance.now();
const [session, workflow] = await Promise.all([
  runtime.createSession({
    callId,
    promptVersion: "elevatebox-outbound-v1",
  }),
  system.startCall(callId),
]);
let forwardRealtimeDirective: (directive: ConversationDirective) => Promise<void> =
  (directive) => session.sendDirective(directive);
const readyAt = performance.now();
const workflowLatency = new LiveCallLatencyRecorder();
workflowLatency.recordPrewarm(readyAt - startedAt);
const workflowSession: ConversationSessionPort = {
  startConversation: (instruction) => session.startConversation(instruction),
  setPreferredLanguage: (language) => session.setPreferredLanguage(language),
  sendAudio: (frame) => session.sendAudio(frame),
  interruptOutput: (playedAudioMs) => session.interruptOutput(playedAudioMs),
  events: () => session.events(),
  close: () => session.close(),
  async sendDirective(directive) {
    if (directive.intent === "CONFIRM_ACTION_SUCCESS") {
      trace.record("runtime", "dry_run.action_simulated", {
        directive,
        reason: "Local mic actions use fake adapters and did not contact an external provider.",
      });
      const simulatedDirective = {
        ...directive,
        data: { ...directive.data, simulated: true },
      };
      trace.record("runtime", "conversation.directive.forwarded", {
        directive: simulatedDirective,
      });
      await forwardRealtimeDirective(simulatedDirective);
      return;
    }
    trace.record("runtime", "conversation.directive.forwarded", { directive });
    await forwardRealtimeDirective(directive);
  },
};
const controller = new LiveCallController(
  workflowSession,
  workflow,
  workflowLatency,
);
trace.record("runtime", "session.ready", {
  readyMs: readyAt - startedAt,
  realtimeModel: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1",
  leadModel,
  leadTimeoutMs,
  leadMaxOutputTokens,
  leadConcurrency,
  playbackBufferMs: PLAYBACK_BUFFER_MS,
  semanticVadEagerness,
  realtimeReasoningEffort,
  realtimeMaxOutputTokens,
  outbound: true,
  dryRunActions: true,
});
console.log(`Realtime READY in ${(readyAt - startedAt).toFixed(0)} ms.`);
console.log(
  `Listening on ${inputFormat}:${inputDevice} with semantic VAD ${semanticVadEagerness}. Press Ctrl-C to stop.`,
);
console.log(`Call trace: ${trace.path}`);
console.log("Lead analysis runs asynchronously; WhatsApp and callback actions are local dry runs.");

let stopping = false;
let speaker: ChildProcess | undefined;
let speakerRestartTimer: ReturnType<typeof setTimeout> | undefined;
let speakerRestartAttempts = 0;
let speakerBackpressured = false;

const scheduleSpeakerRestart = (): void => {
  if (
    stopping ||
    speakerDisabled ||
    speaker !== undefined ||
    speakerRestartTimer !== undefined
  ) return;
  speakerRestartAttempts += 1;
  const delayMs = Math.min(100 * (2 ** (speakerRestartAttempts - 1)), 2_000);
  trace.record("runtime", "speaker.restart_scheduled", {
    attempt: speakerRestartAttempts,
    delayMs,
  });
  speakerRestartTimer = setTimeout(() => {
    speakerRestartTimer = undefined;
    if (stopping || speaker !== undefined) return;
    speaker = startSpeaker();
    drainPlaybackChunk();
  }, delayMs);
};

const startSpeaker = (): ChildProcess | undefined => {
  if (speakerDisabled) return undefined;
  const child = spawn("ffplay", [
    "-loglevel", "error",
    "-nodisp",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-probesize", "32",
    "-analyzeduration", "0",
    "-f", "s16le",
    "-ar", String(SAMPLE_RATE_HZ),
    "-ch_layout", "mono",
    "-i", "pipe:0",
  ], { stdio: ["pipe", "ignore", "inherit"] });
  child.once("spawn", () => {
    if (speaker !== child) return;
    trace.record("runtime", "speaker.started", { pid: child.pid });
  });
  child.once("error", (error) => {
    console.error(`Could not start local speaker playback: ${error.message}`);
    trace.record("runtime", "speaker.failed", { error: error.message });
  });
  child.stdin?.on("error", (error) => {
    if (stopping || speaker !== child) return;
    trace.record("runtime", "speaker.stdin_failed", { error: error.message });
  });
  child.once("close", (code, signal) => {
    const wasCurrentSpeaker = speaker === child;
    if (!wasCurrentSpeaker) return;
    speaker = undefined;
    speakerBackpressured = false;
    const active = playbackSegments[0];
    if (active?.playbackStartedAt !== undefined) {
      // A replacement sink must resume from the bytes already handed off,
      // rather than trying to catch up to wall-clock time in one burst.
      active.playbackStartedAt =
        performance.now() - audioMsForBytes(active.deliveredBytes);
    }
    trace.record("runtime", "speaker.closed", { code, signal });
    if (!stopping) {
      console.error(
        `Local speaker playback exited (${signal ?? `code ${code}`}); restarting.`,
      );
      scheduleSpeakerRestart();
    }
  });
  return child;
};

speaker = startSpeaker();

const microphone = spawn("ffmpeg", [
  "-hide_banner",
  "-loglevel", "error",
  "-f", inputFormat,
  "-i", inputDevice,
  "-ac", "1",
  "-ar", String(SAMPLE_RATE_HZ),
  "-f", "s16le",
  "pipe:1",
], { stdio: ["ignore", "pipe", "inherit"] });

let audioChain: Promise<void> = Promise.resolve();
let firstAudioAt: number | undefined;
let speechStoppedEventAt: number | undefined;
let estimatedSpeechEndAt: number | undefined;
let inputAudioClockStartedAt: number | undefined;
interface PlaybackSegment {
  responseId: string;
  itemId: string;
  chunks: Buffer[];
  offset: number;
  queuedBytes: number;
  totalBytes: number;
  firstAudioAt: number;
  lastAudioAt: number;
  deliveredBytes: number;
  playbackStartedAt?: number;
  done: boolean;
}

let currentOutputItemId: string | undefined;
let currentOutputDurationMs = 0;
let currentOutputFirstAudioAt: number | undefined;
let currentDeliveredAudioMs = 0;
let currentPlaybackStartedAt: number | undefined;
let currentOutputDone = false;
let userSpeechActive = false;
let interruptedOutputItemId: string | undefined;
const playbackSegments: PlaybackSegment[] = [];
let lastPlaybackWriteAt = performance.now();
let lastPlaybackWatchdogAt = 0;
const showPartials = process.env.REALTIME_SHOW_PARTIALS === "1";

const resetOutputClock = (): void => {
  currentOutputItemId = undefined;
  currentOutputDurationMs = 0;
  currentOutputFirstAudioAt = undefined;
  currentDeliveredAudioMs = 0;
  currentPlaybackStartedAt = undefined;
  currentOutputDone = false;
};

const clearPacedPlaybackQueue = (): void => {
  playbackSegments.length = 0;
  resetOutputClock();
};

const drainPlaybackChunk = (): void => {
  const segment = playbackSegments[0];
  if (!segment) {
    resetOutputClock();
    flushPendingImmediateDirectives();
    return;
  }
  currentOutputItemId = segment.itemId;
  currentOutputDurationMs = audioMsForBytes(segment.totalBytes);
  currentOutputFirstAudioAt = segment.firstAudioAt;
  currentDeliveredAudioMs = audioMsForBytes(segment.deliveredBytes);
  currentPlaybackStartedAt = segment.playbackStartedAt;
  currentOutputDone = segment.done;

  if (segment.queuedBytes === 0 && segment.done) {
    if (
      segment.playbackStartedAt === undefined ||
      performance.now() - segment.playbackStartedAt >=
        audioMsForBytes(segment.deliveredBytes)
    ) {
      playbackSegments.shift();
      drainPlaybackChunk();
    }
    return;
  }
  if (!speaker?.stdin?.writable || speakerBackpressured) return;
  if (
    segment.playbackStartedAt === undefined &&
    segment.queuedBytes < PCM16_BYTES_PER_SECOND * (PLAYBACK_BUFFER_MS / 1000) &&
    !segment.done
  ) return;

  const now = performance.now();
  if (segment.playbackStartedAt === undefined) {
    segment.playbackStartedAt = now;
    trace.record("latency", "playback.started", {
      jitterBufferMs: PLAYBACK_BUFFER_MS,
      modelAudioToPlaybackMs: now - segment.firstAudioAt,
      itemId: segment.itemId,
    });
  }
  const elapsedPlaybackMs = now - segment.playbackStartedAt;
  // Pace in exact PCM16 byte counts. Accumulating duration as floating-point
  // milliseconds could strand one final 2-byte sample forever and block every
  // later response behind the otherwise-complete segment.
  const targetDeliveredBytes = pacedPcmTargetBytes({
    totalBytes: segment.totalBytes,
    elapsedMs: elapsedPlaybackMs,
    bufferMs: PLAYBACK_BUFFER_MS,
    bytesPerSecond: PCM16_BYTES_PER_SECOND,
  });
  const requestedBytes = targetDeliveredBytes - segment.deliveredBytes;
  if (requestedBytes <= 0) return;
  const targetBytes = Math.min(requestedBytes, segment.queuedBytes);
  if (targetBytes <= 0) return;
  const output = Buffer.allocUnsafe(targetBytes);
  let written = 0;
  while (written < targetBytes) {
    const head = segment.chunks[0];
    if (!head) break;
    const available = head.byteLength - segment.offset;
    const take = Math.min(available, targetBytes - written);
    head.copy(output, written, segment.offset, segment.offset + take);
    written += take;
    segment.offset += take;
    segment.queuedBytes -= take;
    if (segment.offset === head.byteLength) {
      segment.chunks.shift();
      segment.offset = 0;
    }
  }
  if (written > 0) {
    const targetSpeaker = speaker;
    const targetStdin = targetSpeaker.stdin;
    if (!targetStdin) return;
    const accepted = targetStdin.write(
      written === output.byteLength ? output : output.subarray(0, written),
    );
    // A sink that has accepted real audio is healthy. A later exit should get
    // an immediate first restart; repeated pre-audio failures retain backoff.
    speakerRestartAttempts = 0;
    if (!accepted) {
      speakerBackpressured = true;
      trace.record("latency", "speaker.backpressure", {
        itemId: segment.itemId,
        deliveredAudioMs: audioMsForBytes(segment.deliveredBytes),
      });
      targetStdin.once("drain", () => {
        if (speaker !== targetSpeaker || stopping) return;
        speakerBackpressured = false;
        drainPlaybackChunk();
      });
    }
    segment.deliveredBytes += written;
    lastPlaybackWriteAt = performance.now();
  }
};

interface PendingImmediateDirective {
  directive: ConversationDirective;
  resolve(): void;
  reject(error: unknown): void;
}

const pendingImmediateDirectives: PendingImmediateDirective[] = [];
let forwardingImmediateDirective = false;

const playbackAudiblyIdle = (): boolean =>
  !userSpeechActive &&
  (
    speakerDisabled ||
    (
      speaker !== undefined &&
      playbackSegments.length === 0 &&
      (
        currentOutputItemId === undefined ||
        (
          currentOutputDone &&
          currentPlaybackStartedAt !== undefined &&
          performance.now() - currentPlaybackStartedAt >= currentDeliveredAudioMs
        )
      )
    )
  );

function flushPendingImmediateDirectives(): void {
  if (
    forwardingImmediateDirective ||
    !playbackAudiblyIdle() ||
    pendingImmediateDirectives.length === 0
  ) return;
  const pending = pendingImmediateDirectives.shift();
  if (!pending) return;
  forwardingImmediateDirective = true;
  void session.sendDirective(pending.directive).then(
    () => pending.resolve(),
    (error: unknown) => pending.reject(error),
  ).finally(() => {
    forwardingImmediateDirective = false;
    flushPendingImmediateDirectives();
  });
}

const queueImmediateDirective = (directive: ConversationDirective): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    pendingImmediateDirectives.push({ directive, resolve, reject });
    flushPendingImmediateDirectives();
  });

forwardRealtimeDirective = (directive) =>
  directive.delivery === "IMMEDIATE_IF_IDLE"
    ? queueImmediateDirective(directive)
    : session.sendDirective(directive);

const enqueuePlayback = (
  data: Uint8Array,
  responseId: string,
  itemId: string,
): void => {
  const audioAt = performance.now();
  let segment = playbackSegments.at(-1);
  if (!segment || segment.responseId !== responseId) {
    segment = {
      responseId,
      itemId,
      chunks: [],
      offset: 0,
      queuedBytes: 0,
      totalBytes: 0,
      firstAudioAt: audioAt,
      lastAudioAt: audioAt,
      deliveredBytes: 0,
      done: false,
    };
    playbackSegments.push(segment);
    trace.record("latency", "playback.segment.created", {
      responseId,
      itemId,
      queueDepth: playbackSegments.length,
      speakerWritable: speaker?.stdin?.writable === true,
      speakerBackpressured,
    });
  }
  segment.itemId = itemId;
  segment.lastAudioAt = audioAt;
  segment.chunks.push(Buffer.from(data));
  segment.queuedBytes += data.byteLength;
  segment.totalBytes += data.byteLength;
  const active = playbackSegments[0];
  if (active) {
    currentOutputItemId = active.itemId;
    currentOutputDurationMs = audioMsForBytes(active.totalBytes);
    currentOutputFirstAudioAt = active.firstAudioAt;
    currentDeliveredAudioMs = audioMsForBytes(active.deliveredBytes);
    currentPlaybackStartedAt = active.playbackStartedAt;
    currentOutputDone = active.done;
  }
  drainPlaybackChunk();
};

const estimatedPlayedAudioMs = (): number => {
  const segment = playbackSegments[0];
  if (!segment || segment.playbackStartedAt === undefined) return 0;
  return Math.min(
    audioMsForBytes(segment.totalBytes),
    audioMsForBytes(segment.deliveredBytes),
    Math.max(0, performance.now() - segment.playbackStartedAt),
  );
};

const playbackTimer = setInterval(() => {
  drainPlaybackChunk();
  const now = performance.now();
  const active = playbackSegments[0];
  const waiting = playbackSegments.find((segment, index) =>
    index > 0 && segment.queuedBytes > 0
  );

  // A completed/fully-written segment can retain the head position only while
  // its small paced tail is still audible. If fresh response audio has waited
  // longer than that cushion, advance it rather than blocking the whole call.
  if (
    active &&
    waiting &&
    active.queuedBytes === 0 &&
    now - waiting.firstAudioAt > Math.max(250, PLAYBACK_BUFFER_MS * 2)
  ) {
    trace.record("latency", "playback.stale_head_dropped", {
      responseId: active.responseId,
      itemId: active.itemId,
      done: active.done,
      deliveredAudioMs: audioMsForBytes(active.deliveredBytes),
      waitingResponseId: waiting.responseId,
    });
    playbackSegments.shift();
    drainPlaybackChunk();
    return;
  }

  if (
    active?.queuedBytes &&
    now - Math.max(active.firstAudioAt, lastPlaybackWriteAt) > 500 &&
    now - lastPlaybackWatchdogAt > 500
  ) {
    lastPlaybackWatchdogAt = now;
    trace.record("latency", "playback.stall_detected", {
      responseId: active.responseId,
      itemId: active.itemId,
      queuedBytes: active.queuedBytes,
      deliveredAudioMs: audioMsForBytes(active.deliveredBytes),
      lastAudioAgoMs: now - active.lastAudioAt,
      playbackStarted: active.playbackStartedAt !== undefined,
      speakerWritable: speaker?.stdin?.writable === true,
      speakerBackpressured,
      queueDepth: playbackSegments.length,
    });
    // Re-anchor pacing to bytes already delivered. This cannot duplicate audio;
    // it only lets queued bytes resume after a stale monotonic clock state.
    if (active.playbackStartedAt !== undefined) {
      active.playbackStartedAt =
        now - audioMsForBytes(active.deliveredBytes);
    }
    drainPlaybackChunk();
  }
}, PLAYBACK_CHUNK_MS);

let stopPromise: Promise<void> | undefined;
const stop = (): Promise<void> => {
  if (stopPromise) return stopPromise;
  stopping = true;
  stopPromise = (async () => {
    microphone.kill("SIGINT");
    clearInterval(playbackTimer);
    if (speakerRestartTimer !== undefined) clearTimeout(speakerRestartTimer);
    clearPacedPlaybackQueue();
    speaker?.stdin?.end();
    await audioChain.catch((error: unknown) => {
      trace.record("runtime", "input_audio.send_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    controller.scheduleEnd();
    try {
      await controller.idle();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace.record("summary", "lead_analysis.failed", { error: message });
      console.error(`Lead analysis failed: ${message}`);
    }

    const finalState = workflow.state();
    trace.record("summary", "session.summary", {
      finalState,
      simulatedWhatsAppDeliveries: messaging.deliveries,
      simulatedCallbackBookings: scheduler.bookings,
      latency: workflowLatency.summary(),
    });
    trace.record("runtime", "session.closed", {});
    await session.close();
    speaker?.kill("SIGINT");
    await trace.close();
    console.log(`Final lead: ${finalState.intent} (score ${finalState.intentScore}, confidence ${finalState.intentConfidence.toFixed(2)}).`);
    console.log(`Saved complete call trace to ${trace.path}`);
  })();
  return stopPromise;
};

process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });

microphone.stdout.on("data", (chunk: Buffer) => {
  if (stopping) return;
  const capturedDurationMs = (chunk.byteLength / PCM16_BYTES_PER_SECOND) * 1000;
  inputAudioClockStartedAt ??= performance.now() - capturedDurationMs;
  // Keep sends ordered; Realtime accepts arbitrary PCM16 chunk boundaries.
  audioChain = audioChain.then(() => session.sendAudio({
    data: new Uint8Array(chunk),
    sampleRateHz: SAMPLE_RATE_HZ,
    encoding: "pcm16",
    timestampMs: Math.round((performance.now() - startedAt)),
  }));
});
microphone.once("close", (code) => {
  if (!stopping && code !== 0) console.error(`Microphone capture exited with code ${code}`);
  void stop();
});
microphone.once("error", (error) => {
  console.error(`Could not start microphone capture: ${error.message}`);
  trace.record("runtime", "microphone.failed", { error: error.message });
  void stop();
});

await session.startConversation(ELEVATEBOX_OUTBOUND_START);
trace.record("runtime", "outbound.opening_requested", {});

try {
  for await (const event of session.events()) {
    if (event.type !== "user.speech_started") {
      controller.onEvent(event.type, event.payload);
    }
    if (event.type === "audio.output.delta") {
      const audioAt = performance.now();
      firstAudioAt ??= audioAt;
      const frame = event.payload.frame as { data?: unknown };
      const itemId = typeof event.payload.itemId === "string"
        ? event.payload.itemId
        : "assistant-current";
      const responseId = typeof event.payload.responseId === "string"
        ? event.payload.responseId
        : `response-for-${itemId}`;
      // Cancellation and the socket can cross in flight. Never feed late
      // deltas from a truncated item into the replacement player.
      if (itemId === interruptedOutputItemId) continue;
      interruptedOutputItemId = undefined;
      if (frame.data instanceof Uint8Array) {
        enqueuePlayback(frame.data, responseId, itemId);
      } else {
        trace.record("runtime", "playback.audio_frame_rejected", {
          responseId,
          itemId,
          dataType: Object.prototype.toString.call(frame.data),
        });
      }
      if (speechStoppedEventAt !== undefined) {
        const postVadMs = audioAt - speechStoppedEventAt;
        const fullTtfaMs = estimatedSpeechEndAt === undefined
          ? undefined
          : audioAt - estimatedSpeechEndAt;
        console.log(
          fullTtfaMs === undefined
            ? `First audio: ${postVadMs.toFixed(0)} ms after VAD speech_stopped.`
            : `First audio: ${fullTtfaMs.toFixed(0)} ms estimated TTFA (${postVadMs.toFixed(0)} ms after VAD speech_stopped).`,
        );
        trace.record("latency", "turn.first_audio", {
          postVadMs,
          ...(fullTtfaMs === undefined ? {} : { estimatedTtfaMs: fullTtfaMs }),
        });
        speechStoppedEventAt = undefined;
        estimatedSpeechEndAt = undefined;
      }
    } else if (event.type === "user.speech_started") {
      userSpeechActive = true;
      const speechStartedEventAt = performance.now();
      if (
        currentOutputItemId !== undefined &&
        currentOutputDurationMs > 0
      ) {
        const playedAudioMs = estimatedPlayedAudioMs();
        const queuedAudioMs = Math.max(0, currentOutputDurationMs - playedAudioMs);
        if (!currentOutputDone || queuedAudioMs > 10) {
          interruptedOutputItemId = currentOutputItemId;
          // Keep the server conversation aligned with what actually reached the
          // speaker and discard only the application queue. The session-scoped
          // ffplay process stays alive, avoiding ALSA teardown/reopen gaps.
          clearPacedPlaybackQueue();
          await session.interruptOutput(playedAudioMs);
          console.log(
            `Barge-in: playback cleared; truncated assistant at ${playedAudioMs.toFixed(0)} ms ` +
            `(${queuedAudioMs.toFixed(0)} ms queued audio discarded).`,
          );
          trace.record("latency", "playback.barge_in_cleared", {
            playedAudioMs,
            queuedAudioDiscardedMs: queuedAudioMs,
          });
        }
        resetOutputClock();
      }
      // Barge-in is the highest-priority event: clear audio before observers,
      // terminal output, or file logging get any event-loop time.
      controller.onEvent(event.type, event.payload);
      const audioStartMs = event.payload.audio_start_ms;
      if (
        inputAudioClockStartedAt !== undefined &&
        typeof audioStartMs === "number" &&
        Number.isFinite(audioStartMs)
      ) {
        trace.record("latency", "barge_in.detected", {
          estimatedDetectionMs: Math.max(
            0,
            speechStartedEventAt - (inputAudioClockStartedAt + audioStartMs),
          ),
        });
      }
      trace.record("runtime", "user.speech_started", {
        audioStartMs,
        itemId: event.payload.item_id,
      });
    } else if (event.type === "response.output_audio.done") {
      // A reasoning Realtime response may contain more than one audio output
      // item. Keep its response-scoped segment open until response.done.
      drainPlaybackChunk();
    } else if (event.type === "response.done") {
      const response = event.payload.response && typeof event.payload.response === "object"
        ? event.payload.response as Record<string, unknown>
        : undefined;
      const responseId = typeof response?.id === "string" ? response.id : undefined;
      for (const segment of playbackSegments) {
        if (responseId === undefined || segment.responseId === responseId) {
          segment.done = true;
        }
      }
      if (
        responseId === undefined ||
        playbackSegments[0]?.responseId === responseId
      ) currentOutputDone = true;
      trace.record("runtime", "realtime.response.done", {
        responseId,
        status: response?.status,
        incompleteReason:
          (response?.status_details as Record<string, unknown> | undefined)?.reason,
        playbackQueue: playbackSegments.map((segment) => ({
          responseId: segment.responseId,
          itemId: segment.itemId,
          queuedBytes: segment.queuedBytes,
          deliveredAudioMs: audioMsForBytes(segment.deliveredBytes),
          done: segment.done,
        })),
      });
      drainPlaybackChunk();
    } else if (event.type === "user.speech_stopped") {
      userSpeechActive = false;
      speechStoppedEventAt = performance.now();
      const audioEndMs = event.payload.audio_end_ms;
      trace.record("runtime", "user.speech_stopped", {
        audioEndMs,
        itemId: event.payload.item_id,
      });
      if (
        inputAudioClockStartedAt !== undefined &&
        typeof audioEndMs === "number" &&
        Number.isFinite(audioEndMs)
      ) {
        estimatedSpeechEndAt = inputAudioClockStartedAt + audioEndMs;
        const endpointMs = Math.max(0, speechStoppedEventAt - estimatedSpeechEndAt);
        console.log(`Endpoint/VAD notification: ~${endpointMs.toFixed(0)} ms after speech audio ended.`);
        trace.record("latency", "turn.endpoint", {
          estimatedEndpointMs: endpointMs,
          audioEndMs,
        });
      } else {
        estimatedSpeechEndAt = undefined;
      }
    } else if (event.type === "user.transcript.delta" && showPartials) {
      const delta = event.payload.delta;
      if (typeof delta === "string" && delta) console.log(`Partial: ${delta}`);
    } else if (event.type === "user.turn.completed") {
      const transcript = event.payload.transcript;
      if (typeof transcript === "string" && transcript.trim()) {
        const text = transcript.trim();
        const selectedLanguage = explicitLanguageSelection(text);
        if (selectedLanguage !== undefined && selectedLanguage !== lockedLanguage) {
          lockedLanguage = selectedLanguage;
          await session.setPreferredLanguage(selectedLanguage as SupportedLanguage);
          trace.record("runtime", "conversation.language_locked", {
            language: selectedLanguage,
            sourceTurnId: event.payload.turnId,
          });
          console.log(`[Language] Locked to ${selectedLanguage}.`);
        }
        console.log(`Lead: ${text}`);
        trace.record("runtime", "user.turn.completed", {
          turnId: event.payload.turnId,
          turnSequence: event.payload.turnSequence,
          transcript: text,
          languages: event.payload.languages,
        });
      }
    } else if (event.type === "agent.turn.completed") {
      const transcript = event.payload.transcript;
      if (typeof transcript === "string" && transcript.trim()) {
        console.log(`Assistant: ${transcript.trim()}`);
        trace.record("runtime", "agent.turn.completed", {
          itemId: event.payload.itemId,
          responseId: event.payload.responseId,
          transcript: transcript.trim(),
        });
      }
    } else if (event.type === "provider.error" || event.type === "provider.protocol_error") {
      console.error("Realtime error:", event.payload);
      trace.record("runtime", event.type, event.payload);
    }
  }
} finally {
  await stop();
  if (firstAudioAt !== undefined) {
    console.log(`First model audio in ${(firstAudioAt - readyAt).toFixed(0)} ms after READY.`);
  }
}

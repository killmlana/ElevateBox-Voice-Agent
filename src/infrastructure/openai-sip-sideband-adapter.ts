import type {
  ConversationControlSessionPort,
  ConversationDirective,
  SessionContext,
  SupportedLanguage,
  VoiceRuntimeEvent,
} from "../contracts.ts";
import {
  directiveInstruction,
  immediateDirectiveInstruction,
  languageLockInstruction,
  type RealtimeSocket,
  type RealtimeSocketFactory,
} from "./openai-realtime-runtime.ts";
import { safeReference } from "./sanitized-logger.ts";

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";

export class OpenAISipSidebandClosedError extends Error {
  readonly closeCode: number;
  readonly reasonRef: string;
  readonly configured: boolean;

  constructor(closeCode: number, reason: string, configured: boolean) {
    const reasonRef = safeReference(reason || "no close reason");
    super(
      `OpenAI SIP sideband closed unexpectedly ${
        configured ? "after ready" : "before ready"
      } (code ${closeCode}, reasonRef ${reasonRef})`,
    );
    this.name = "OpenAISipSidebandClosedError";
    this.closeCode = closeCode;
    this.reasonRef = reasonRef;
    this.configured = configured;
  }
}

export interface OpenAISipSessionConfig {
  apiKey: string;
  instructions: string;
  model: string;
  voice: string;
  inputTranscriptionModel: string | null;
  transcriptionPrompt?: string;
  semanticVadEagerness?: "low" | "medium" | "high" | "auto";
  maxOutputTokens?: number | "inf";
  reasoningEffort: "low" | "medium" | "high";
  languages: readonly SupportedLanguage[];
  safetyIdentifier?: string;
  handshakeTimeoutMs: number;
  requestTimeoutMs?: number;
  apiBaseUrl?: string;
  realtimeUrl?: string;
}

export interface OpenAISipControlPort {
  accept(
    callId: string,
    context: SessionContext,
  ): Promise<ConversationControlSessionPort>;
  reject(callId: string, statusCode?: number): Promise<void>;
  hangup(callId: string): Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface PendingNext<T> {
  resolve(value: IteratorResult<T>): void;
  reject(error: unknown): void;
}

class AsyncEventQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: PendingNext<T>[] = [];
  private ended = false;
  private failure?: unknown;

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  push(value: T): void {
    if (this.ended || this.failure !== undefined) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.ended || this.failure !== undefined) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function baseInstructions(
  config: OpenAISipSessionConfig,
  context: SessionContext,
): string {
  return [
    config.instructions,
    ...(context.preferredLanguage
      ? [languageLockInstruction(context.preferredLanguage)]
      : []),
  ].join("\n\n");
}

export function buildOpenAISipAcceptRequest(
  config: OpenAISipSessionConfig,
  context: SessionContext,
): Record<string, unknown> {
  const transcription = config.inputTranscriptionModel
    ? {
        model: config.inputTranscriptionModel,
        ...(config.transcriptionPrompt === undefined
          ? {}
          : { prompt: config.transcriptionPrompt }),
      }
    : undefined;
  return {
    type: "realtime",
    model: config.model,
    output_modalities: ["audio"],
    instructions: baseInstructions(config, context),
    ...(config.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: config.maxOutputTokens }),
    reasoning: { effort: config.reasoningEffort },
    tracing: {
      workflow_name: "ElevateBox SIP outbound",
      group_id: safeReference(context.callId),
    },
    audio: {
      input: {
        format: { type: "audio/pcma" },
        ...(transcription === undefined ? {} : { transcription }),
        turn_detection: {
          type: "semantic_vad",
          ...(config.semanticVadEagerness === undefined
            ? {}
            : { eagerness: config.semanticVadEagerness }),
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        format: { type: "audio/pcma" },
        voice: config.voice,
      },
    },
  };
}

export class OpenAISipSidebandAdapter implements OpenAISipControlPort {
  private readonly config: OpenAISipSessionConfig;
  private readonly socketFactory: RealtimeSocketFactory;
  private readonly fetchFn: typeof fetch;

  constructor(
    config: OpenAISipSessionConfig,
    socketFactory: RealtimeSocketFactory,
    fetchFn: typeof fetch = fetch,
  ) {
    if (!config.apiKey.trim()) throw new Error("OpenAI API key is required");
    if (!config.instructions.trim()) throw new Error("Realtime instructions are required");
    this.config = config;
    this.socketFactory = socketFactory;
    this.fetchFn = fetchFn;
  }

  async accept(
    callId: string,
    context: SessionContext,
  ): Promise<ConversationControlSessionPort> {
    await this.request(
      `/realtime/calls/${encodeURIComponent(callId)}/accept`,
      buildOpenAISipAcceptRequest(this.config, context),
    );
    const session = new OpenAISipControlSession(
      callId,
      context,
      this.config,
      this.socketFactory,
    );
    await session.initialize();
    return session;
  }

  async reject(callId: string, statusCode = 603): Promise<void> {
    await this.request(
      `/realtime/calls/${encodeURIComponent(callId)}/reject`,
      { status_code: statusCode },
    );
  }

  async hangup(callId: string): Promise<void> {
    await this.request(`/realtime/calls/${encodeURIComponent(callId)}/hangup`);
  }

  private async request(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs ?? 10_000,
    );
    try {
      const response = await this.fetchFn(
        `${(this.config.apiBaseUrl ?? OPENAI_API_BASE_URL).replace(/\/$/, "")}${path}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(this.config.safetyIdentifier === undefined
              ? {}
              : { "OpenAI-Safety-Identifier": this.config.safetyIdentifier }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`OpenAI SIP control request failed with HTTP ${response.status}`);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("OpenAI SIP control request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

class OpenAISipControlSession implements ConversationControlSessionPort {
  private readonly ready = deferred<void>();
  private readonly eventQueue = new AsyncEventQueue<VoiceRuntimeEvent>();
  private readonly socket: RealtimeSocket;
  private readonly callId: string;
  private readonly context: SessionContext;
  private readonly config: OpenAISipSessionConfig;
  private sequence = 0;
  private configured = false;
  private closed = false;
  private responseActive = false;
  private inputSpeechActive = false;
  private preferredLanguage: SupportedLanguage | undefined;
  private inputTurnSequence = 0;
  private readonly inputTurnOrder = new Map<string, number>();
  private readonly pendingImmediateDirectives: ConversationDirective[] = [];
  private readonly sentImmediateDirectiveIds = new Set<string>();
  private modelResponseStartedForResponse: string | undefined;
  private bargeInCancellationPending = false;

  constructor(
    callId: string,
    context: SessionContext,
    config: OpenAISipSessionConfig,
    socketFactory: RealtimeSocketFactory,
  ) {
    this.callId = callId;
    this.context = context;
    this.config = config;
    this.preferredLanguage = context.preferredLanguage;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      ...(config.safetyIdentifier === undefined
        ? {}
        : { "OpenAI-Safety-Identifier": config.safetyIdentifier }),
    };
    this.socket = socketFactory.connect({
      url: `${config.realtimeUrl ?? OPENAI_REALTIME_URL}?call_id=${encodeURIComponent(callId)}`,
      headers,
      handlers: {
        open: () => {
          // This socket attaches to a SIP session that was already created by
          // the accept endpoint. OpenAI's SIP monitoring flow allows commands
          // as soon as the WebSocket upgrade succeeds and does not guarantee a
          // new session.created event for the attached connection.
          this.markReady();
        },
        message: (data) => this.handleMessage(data),
        error: (error) => this.handleTransportError(error),
        close: (code, reason) => this.handleClose(code, reason),
      },
    });
  }

  async initialize(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("OpenAI SIP sideband timed out opening the WebSocket")),
        this.config.handshakeTimeoutMs,
      );
    });
    try {
      await Promise.race([this.ready.promise, timeout]);
    } catch (error) {
      this.socket.close(1000, "sideband handshake failed");
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async startConversation(instruction?: string): Promise<void> {
    this.assertUsable();
    this.responseActive = true;
    this.send({
      event_id: this.nextEventId("response"),
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        ...(instruction === undefined ? {} : { instructions: instruction }),
      },
    });
  }

  async setPreferredLanguage(language: SupportedLanguage): Promise<void> {
    this.assertUsable();
    this.preferredLanguage = language;
    this.send({
      event_id: this.nextEventId("language"),
      type: "session.update",
      session: { type: "realtime", instructions: this.sessionInstructions() },
    });
  }

  async sendDirective(directive: ConversationDirective): Promise<void> {
    this.assertUsable();
    if (directive.callId !== this.context.callId) {
      throw new Error("Directive callId does not match the SIP session");
    }
    if (directive.delivery === "IMMEDIATE_IF_IDLE") {
      if (this.sentImmediateDirectiveIds.has(directive.directiveId)) return;
      this.sentImmediateDirectiveIds.add(directive.directiveId);
      this.pendingImmediateDirectives.push(directive);
      this.flushImmediateDirective();
      return;
    }
    this.send({
      event_id: this.nextEventId("directive"),
      type: "session.update",
      session: {
        type: "realtime",
        instructions: this.sessionInstructions(directiveInstruction(directive)),
      },
    });
  }

  async cancelOutput(): Promise<void> {
    this.assertUsable();
    if (!this.responseActive) return;
    this.send({ event_id: this.nextEventId("cancel"), type: "response.cancel" });
    this.responseActive = false;
  }

  events(): AsyncIterable<VoiceRuntimeEvent> {
    return this.eventQueue;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(1000, "application close");
    this.eventQueue.end();
  }

  private sessionInstructions(applicationUpdate?: string): string {
    return [
      this.config.instructions,
      ...(this.preferredLanguage
        ? [languageLockInstruction(this.preferredLanguage)]
        : []),
      ...(applicationUpdate
        ? [`APPLICATION STATE UPDATE:\n${applicationUpdate}`]
        : []),
    ].join("\n\n");
  }

  private handleMessage(data: string): void {
    let event: Record<string, unknown>;
    try {
      const parsed = asRecord(JSON.parse(data));
      if (!parsed || typeof parsed.type !== "string") {
        throw new Error("Realtime event must contain a type");
      }
      event = parsed;
    } catch (error) {
      this.eventQueue.push({
        type: "provider.protocol_error",
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
      return;
    }

    const type = event.type as string;
    if (type === "session.created") {
      this.markReady();
      return;
    }
    if (type === "input_audio_buffer.committed") {
      if (typeof event.item_id === "string") this.sequenceForInputItem(event.item_id);
      this.eventQueue.push({ type, payload: event });
      return;
    }
    if (type === "conversation.item.input_audio_transcription.delta") {
      this.eventQueue.push({
        type: "user.transcript.delta",
        payload: { itemId: event.item_id, delta: event.delta },
      });
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      if (typeof event.item_id !== "string" || typeof event.transcript !== "string") {
        this.eventQueue.push({
          type: "provider.protocol_error",
          payload: { message: "Completed input transcription was malformed" },
        });
        return;
      }
      this.eventQueue.push({
        type: "user.turn.completed",
        payload: {
          turnId: event.item_id,
          itemId: event.item_id,
          turnSequence: this.sequenceForInputItem(event.item_id),
          transcript: event.transcript.trim(),
          languages: event.languages,
        },
      });
      return;
    }
    if (type === "conversation.item.input_audio_transcription.failed") {
      const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
      this.eventQueue.push({
        type: "user.transcription.failed",
        payload: {
          ...event,
          ...(itemId ? {
            turnId: itemId,
            turnSequence: this.sequenceForInputItem(itemId),
          } : {}),
        },
      });
      return;
    }
    if (type === "response.output_item.added") {
      this.responseActive = true;
      this.eventQueue.push({ type, payload: event });
      return;
    }
    if (type === "response.output_audio.delta") {
      this.emitModelResponseStarted(event, "audio_delta");
      return;
    }
    if (type === "response.output_audio_transcript.delta") {
      // SIP audio is carried directly by OpenAI and Asterisk, so a sideband
      // socket may omit output_audio.delta. Audio responses include a
      // transcript; its first delta is the earliest media-free response-start
      // signal that this process can consistently observe.
      this.emitModelResponseStarted(event, "audio_transcript_delta");
      this.eventQueue.push({
        type: "agent.transcript.delta",
        payload: { delta: event.delta, responseId: event.response_id, itemId: event.item_id },
      });
      return;
    }
    if (type === "response.output_audio_transcript.done") {
      // Some attached SIP sockets may coalesce transcript output and omit
      // deltas. The completed transcript is a later but still honest fallback
      // rather than leaving the response latency missing altogether.
      this.emitModelResponseStarted(event, "audio_transcript_done");
      this.eventQueue.push({
        type: "agent.turn.completed",
        payload: {
          transcript: event.transcript,
          responseId: event.response_id,
          itemId: event.item_id,
        },
      });
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      this.inputSpeechActive = true;
      this.eventQueue.push({ type: "user.speech_started", payload: event });
      if (this.responseActive) {
        this.send({ event_id: this.nextEventId("barge-in"), type: "response.cancel" });
        this.responseActive = false;
        this.bargeInCancellationPending = true;
        this.eventQueue.push({ type: "sip.response_cancel_sent", payload: {} });
      }
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      this.inputSpeechActive = false;
      this.eventQueue.push({ type: "user.speech_stopped", payload: event });
      return;
    }
    if (type === "response.created") {
      this.responseActive = true;
      this.modelResponseStartedForResponse = undefined;
      this.eventQueue.push({ type, payload: event });
      return;
    }
    if (type === "response.done") {
      this.responseActive = false;
      const response = asRecord(event.response);
      if (this.bargeInCancellationPending) {
        if (response?.status === "cancelled") {
          this.eventQueue.push({ type: "sip.response_cancelled", payload: {} });
        }
        this.bargeInCancellationPending = false;
      }
      this.eventQueue.push({ type, payload: event });
      this.flushImmediateDirective();
      return;
    }
    if (type === "error") {
      const providerError = asRecord(event.error);
      const message = typeof providerError?.message === "string"
        ? providerError.message
        : "OpenAI Realtime sideband returned an error";
      if (!this.configured) this.ready.reject(new Error(message));
      this.eventQueue.push({ type: "provider.error", payload: event });
      return;
    }
    this.eventQueue.push({ type, payload: event });
  }

  private emitModelResponseStarted(
    event: Record<string, unknown>,
    observedVia: "audio_delta" | "audio_transcript_delta" | "audio_transcript_done",
  ): void {
    const responseId = typeof event.response_id === "string"
      ? event.response_id
      : "current";
    if (this.modelResponseStartedForResponse === responseId) return;
    this.modelResponseStartedForResponse = responseId;
    this.eventQueue.push({
      type: "model.response.started",
      payload: { responseId, itemId: event.item_id, observedVia },
    });
  }

  private handleTransportError(error: Error): void {
    this.ready.reject(error);
    this.eventQueue.fail(error);
  }

  private markReady(): void {
    if (this.configured) return;
    this.configured = true;
    this.ready.resolve(undefined);
    this.eventQueue.push({ type: "session.ready", payload: { callId: this.callId } });
  }

  private handleClose(code: number, reason: string): void {
    const applicationClose = this.closed;
    this.closed = true;
    if (applicationClose) {
      this.eventQueue.end();
      return;
    }
    const error = new OpenAISipSidebandClosedError(code, reason, this.configured);
    if (!this.configured) this.ready.reject(error);
    this.eventQueue.fail(error);
  }

  private assertUsable(): void {
    if (!this.configured || this.closed) {
      throw new Error("OpenAI SIP sideband session is not ready");
    }
  }

  private sequenceForInputItem(itemId: string): number {
    const existing = this.inputTurnOrder.get(itemId);
    if (existing !== undefined) return existing;
    this.inputTurnSequence += 1;
    this.inputTurnOrder.set(itemId, this.inputTurnSequence);
    return this.inputTurnSequence;
  }

  private nextEventId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence.toString().padStart(6, "0")}`;
  }

  private send(event: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(event));
  }

  private flushImmediateDirective(): void {
    if (
      this.closed ||
      this.responseActive ||
      this.inputSpeechActive ||
      this.pendingImmediateDirectives.length === 0
    ) return;
    const directive = this.pendingImmediateDirectives.shift();
    if (!directive) return;
    this.responseActive = true;
    this.send({
      event_id: this.nextEventId("directive-response"),
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: immediateDirectiveInstruction(directive),
        max_output_tokens: 96,
      },
    });
  }
}

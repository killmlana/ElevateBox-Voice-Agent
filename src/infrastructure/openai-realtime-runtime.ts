import type {
  AudioFrame,
  ConversationDirective,
  ConversationRuntime,
  ConversationSessionPort,
  SessionContext,
  SupportedLanguage,
  VoiceCapabilities,
  VoiceRuntimeEvent,
} from "../contracts.ts";

const REALTIME_URL = "wss://api.openai.com/v1/realtime";

export interface RealtimeSocketHandlers {
  open(): void;
  message(data: string): void;
  error(error: Error): void;
  close(code: number, reason: string): void;
}

export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RealtimeSocketFactory {
  connect(options: {
    url: string;
    headers: Readonly<Record<string, string>>;
    handlers: RealtimeSocketHandlers;
  }): RealtimeSocket;
}

export interface OpenAIRealtimeRuntimeConfig {
  apiKey: string;
  instructions: string;
  model?: string;
  voice?: string;
  handshakeTimeoutMs?: number;
  safetyIdentifier?: string;
  languages?: readonly SupportedLanguage[];
  inputTranscriptionModel?: string | null;
  transcriptionPrompt?: string;
  semanticVadEagerness?: "low" | "medium" | "high" | "auto";
  maxOutputTokens?: number | "inf";
  reasoningEffort?: "low" | "medium" | "high";
}

interface ResolvedConfig {
  apiKey: string;
  instructions: string;
  model: string;
  voice: string;
  handshakeTimeoutMs: number;
  safetyIdentifier?: string;
  inputTranscriptionModel: string | null;
  transcriptionPrompt?: string;
  semanticVadEagerness?: "low" | "medium" | "high" | "auto";
  maxOutputTokens?: number | "inf";
  reasoningEffort: "low" | "medium" | "high";
  languages: readonly SupportedLanguage[];
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

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function eventId(prefix: string, sequence: number): string {
  return `${prefix}_${sequence.toString().padStart(6, "0")}`;
}

function directiveInstruction(directive: ConversationDirective): string {
  const details = JSON.stringify(directive.data);
  switch (directive.intent) {
    case "ASK_SEND_PERMISSION":
      return `At the next natural pause, ask permission before sending details. Context: ${details}`;
    case "ASK_CALLBACK_CLARIFICATION":
      return `Ask one concise question to resolve the callback date or time. Context: ${details}`;
    case "INTENT_UPDATED":
      return `Internal lead state changed. Adapt naturally and never mention an internal lead label. Context: ${details}`;
    case "CONFIRM_ACTION_SUCCESS":
      if (directive.data.simulated === true) {
        return `LOCAL DRY RUN ONLY: The application recorded a simulated ${String(directive.data.kind ?? "action")}; no real message or booking occurred. Never claim it was sent or booked. Briefly say the simulation was recorded. If budget, timeline, and requirements are already known, recap once, thank the lead, say goodbye, and ask no further questions. Context: ${details}`;
      }
      return `The external action has succeeded; confirm it naturally at the next suitable turn. Context: ${details}`;
    case "REPORT_ACTION_FAILURE":
      return `The external action failed; apologize briefly and do not claim success. Context: ${details}`;
  }
}

function immediateDirectiveInstruction(directive: ConversationDirective): string {
  const simulated = directive.data.simulated === true;
  if (directive.intent === "CONFIRM_ACTION_SUCCESS") {
    const kind = String(directive.data.kind ?? "action");
    if (simulated) {
      return `Speak exactly one brief sentence in the lead's locked language: "Okay, local test mein ${kind} simulate ho gaya; real message nahi gaya." Do not recap, ask a question, or request confirmation.`;
    }
    if (kind === "SEND_HOT_DETAILS") {
      return `Speak exactly one brief sentence in the lead's locked language: "Okay, send ho gaya." Do not recap, ask a question, or request confirmation.`;
    }
    if (kind === "BOOK_CALLBACK") {
      return `Speak exactly one brief sentence in the lead's locked language: "Okay, callback book ho gaya." Do not recap, ask a question, or request confirmation.`;
    }
    return `Speak exactly one brief sentence confirming that the ${kind} action succeeded. Do not recap, ask a question, or request confirmation.`;
  }
  return "Speak one brief apology saying the requested action did not complete. Do not claim success, recap, or ask another question.";
}

function transcriptionLanguages(
  languages: readonly SupportedLanguage[] | undefined,
): string[] {
  const mapped = new Set<string>();
  for (const language of languages ?? []) {
    if (language === "EN") mapped.add("en");
    if (language === "HI") mapped.add("hi");
    if (language === "TE") mapped.add("te");
  }
  return [...mapped];
}

function languageLockInstruction(language: SupportedLanguage): string {
  if (language === "HI") {
    return "LANGUAGE LOCK: The lead explicitly chose Hindi. Keep Hindi/Hinglish as the base for every reply, with Hindi sentence structure. Common English business or technical terms are fine. Do not switch the base language merely because the lead code-switches; switch only if they explicitly request another language.";
  }
  if (language === "TE") {
    return "LANGUAGE LOCK: The lead explicitly chose Telugu. Keep Telugu as the base for every reply. Common English business or technical terms are fine. Do not switch the base language merely because the lead code-switches; switch only if they explicitly request another language.";
  }
  if (language === "EN") {
    return "LANGUAGE LOCK: The lead explicitly chose English. Keep English as the base for every reply; switch only if they explicitly request another language.";
  }
  return "The lead is code-switching. Continue in the last explicitly selected base language unless they directly request a switch.";
}

export class OpenAIRealtimeRuntime implements ConversationRuntime {
  readonly capabilities: VoiceCapabilities;
  private readonly config: ResolvedConfig;
  private readonly socketFactory: RealtimeSocketFactory;

  constructor(
    config: OpenAIRealtimeRuntimeConfig,
    socketFactory: RealtimeSocketFactory,
  ) {
    if (!config.apiKey.trim()) throw new Error("OpenAI API key is required");
    if (!config.instructions.trim()) throw new Error("Realtime instructions are required");
    const maxOutputTokens = config.maxOutputTokens;
    if (
      maxOutputTokens !== undefined &&
      maxOutputTokens !== "inf" &&
      (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096)
    ) {
      throw new Error('maxOutputTokens must be "inf" or an integer between 1 and 4096');
    }
    this.config = {
      apiKey: config.apiKey,
      instructions: config.instructions,
      model: config.model ?? "gpt-realtime-2.1",
      voice: config.voice ?? "marin",
      handshakeTimeoutMs: config.handshakeTimeoutMs ?? 10_000,
      inputTranscriptionModel:
        config.inputTranscriptionModel === undefined
          ? "gpt-live-transcribe"
          : config.inputTranscriptionModel,
      languages: config.languages ?? ["UNKNOWN"],
      ...(config.safetyIdentifier === undefined
        ? {}
        : { safetyIdentifier: config.safetyIdentifier }),
      ...(config.transcriptionPrompt === undefined
        ? {}
        : { transcriptionPrompt: config.transcriptionPrompt }),
      ...(config.semanticVadEagerness === undefined
        ? {}
        : { semanticVadEagerness: config.semanticVadEagerness }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      reasoningEffort: config.reasoningEffort ?? "low",
    };
    this.socketFactory = socketFactory;
    this.capabilities = {
      bargeIn: true,
      serverVad: true,
      nativeAudio: true,
      languages: config.languages ?? ["UNKNOWN"],
    };
  }

  async createSession(context: SessionContext): Promise<ConversationSessionPort> {
    const session = new OpenAIRealtimeSession(
      this.config,
      this.socketFactory,
      context,
    );
    await session.initialize();
    return session;
  }
}

class OpenAIRealtimeSession implements ConversationSessionPort {
  private readonly ready = deferred<void>();
  private readonly eventQueue = new AsyncEventQueue<VoiceRuntimeEvent>();
  private readonly socket: RealtimeSocket;
  private readonly config: ResolvedConfig;
  private readonly context: SessionContext;
  private sequence = 0;
  private transportOpened = false;
  private configurationSent = false;
  private configured = false;
  private closed = false;
  private lastAssistantItemId?: string;
  private responseActive = false;
  private inputSpeechActive = false;
  private readonly pendingImmediateDirectives: ConversationDirective[] = [];
  private readonly sentImmediateDirectiveIds = new Set<string>();
  private preferredLanguage?: SupportedLanguage;
  private inputTurnSequence = 0;
  private readonly inputTurnOrder = new Map<string, number>();

  constructor(
    config: ResolvedConfig,
    socketFactory: RealtimeSocketFactory,
    context: SessionContext,
  ) {
    this.config = config;
    this.context = context;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
    };
    if (config.safetyIdentifier) {
      headers["OpenAI-Safety-Identifier"] = config.safetyIdentifier;
    }
    this.socket = socketFactory.connect({
      url: `${REALTIME_URL}?model=${encodeURIComponent(config.model)}`,
      headers,
      handlers: {
        open: () => {
          this.transportOpened = true;
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
        () => reject(
          new Error(
            `OpenAI Realtime session handshake timed out ${this.handshakeStage()}`,
          ),
        ),
        this.config.handshakeTimeoutMs,
      );
    });
    try {
      await Promise.race([this.ready.promise, timeout]);
    } catch (error) {
      this.socket.close(1000, "handshake failed");
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async sendAudio(frame: AudioFrame): Promise<void> {
    this.assertUsable();
    if (frame.encoding !== "pcm16" || frame.sampleRateHz !== 24000) {
      throw new Error(
        "OpenAI Realtime input expects mono pcm16 at 24000 Hz; convert in MediaGateway",
      );
    }
    this.send({
      event_id: this.nextEventId("audio"),
      type: "input_audio_buffer.append",
      audio: bytesToBase64(frame.data),
    });
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
      session: {
        type: "realtime",
        instructions: this.sessionInstructions(),
      },
    });
  }

  async sendDirective(directive: ConversationDirective): Promise<void> {
    this.assertUsable();
    if (directive.callId !== this.context.callId) {
      throw new Error("Directive callId does not match the Realtime session");
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

  async interruptOutput(playedAudioMs: number): Promise<void> {
    this.assertUsable();
    if (!Number.isFinite(playedAudioMs) || playedAudioMs < 0) {
      throw new Error("playedAudioMs must be a non-negative finite number");
    }
    if (!this.lastAssistantItemId) return;
    this.send({
      event_id: this.nextEventId("truncate"),
      type: "conversation.item.truncate",
      item_id: this.lastAssistantItemId,
      content_index: 0,
      audio_end_ms: Math.round(playedAudioMs),
    });
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

  private configureSession(): void {
    if (this.configurationSent) return;
    this.configurationSent = true;
    const languages = transcriptionLanguages(this.configuredLanguages());
    const transcription = this.config.inputTranscriptionModel
      ? {
          model: this.config.inputTranscriptionModel,
          ...(languages.length === 0 ? {} : { languages }),
          ...(this.config.transcriptionPrompt === undefined
            ? {}
            : { prompt: this.config.transcriptionPrompt }),
        }
      : undefined;
    this.send({
      event_id: this.nextEventId("configure"),
      type: "session.update",
      session: {
        type: "realtime",
        model: this.config.model,
        output_modalities: ["audio"],
        ...(this.config.maxOutputTokens === undefined
          ? {}
          : { max_output_tokens: this.config.maxOutputTokens }),
        reasoning: { effort: this.config.reasoningEffort },
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            ...(transcription === undefined ? {} : { transcription }),
            turn_detection: {
              type: "semantic_vad",
              ...(this.config.semanticVadEagerness === undefined
                ? {}
                : { eagerness: this.config.semanticVadEagerness }),
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: this.config.voice,
          },
        },
        instructions: this.sessionInstructions(),
      },
    });
  }

  private sessionInstructions(applicationUpdate?: string): string {
    return [
      this.config.instructions,
      ...(this.preferredLanguage === undefined
        ? []
        : [languageLockInstruction(this.preferredLanguage)]),
      ...(applicationUpdate === undefined
        ? []
        : [`APPLICATION STATE UPDATE:\n${applicationUpdate}`]),
    ].join("\n\n");
  }

  private handleMessage(data: string): void {
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data) as unknown;
      const record = asRecord(parsed);
      if (!record || typeof record.type !== "string") {
        throw new Error("Realtime event must be an object with a type");
      }
      event = record;
    } catch (error) {
      this.eventQueue.push({
        type: "provider.protocol_error",
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
      return;
    }

    const type = event.type as string;
    if (type === "session.created") {
      this.eventQueue.push({ type, payload: event });
      this.configureSession();
      return;
    }

    if (type === "session.updated") {
      if (this.configurationSent && !this.configured) {
        this.configured = true;
        this.ready.resolve(undefined);
        this.eventQueue.push({ type: "session.ready", payload: {} });
      }
      return;
    }

    if (type === "response.output_item.added") {
      this.responseActive = true;
      const item = asRecord(event.item);
      if (item && typeof item.id === "string") this.lastAssistantItemId = item.id;
      this.eventQueue.push({ type, payload: event });
      return;
    }

    if (type === "input_audio_buffer.committed") {
      if (typeof event.item_id === "string") {
        this.sequenceForInputItem(event.item_id);
      }
      this.eventQueue.push({ type, payload: event });
      return;
    }

    if (type === "conversation.item.input_audio_transcription.delta") {
      this.eventQueue.push({
        type: "user.transcript.delta",
        payload: {
          itemId: event.item_id,
          delta: event.delta,
        },
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
      const turnSequence = this.sequenceForInputItem(event.item_id);
      this.eventQueue.push({
        type: "user.turn.completed",
        payload: {
          turnId: event.item_id,
          itemId: event.item_id,
          turnSequence,
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
          ...(itemId === undefined
            ? {}
            : {
                turnId: itemId,
                turnSequence: this.sequenceForInputItem(itemId),
              }),
        },
      });
      return;
    }

    if (type === "response.output_audio.delta") {
      if (typeof event.delta !== "string") {
        this.eventQueue.push({
          type: "provider.protocol_error",
          payload: { message: "Audio delta did not contain Base64 audio" },
        });
        return;
      }
      this.eventQueue.push({
        type: "audio.output.delta",
        payload: {
          frame: {
            data: base64ToBytes(event.delta),
            sampleRateHz: 24000,
            encoding: "pcm16",
            timestampMs: Date.now(),
          } satisfies AudioFrame,
          responseId: event.response_id,
          itemId: event.item_id ?? this.lastAssistantItemId,
        },
      });
      return;
    }

    if (type === "response.output_audio_transcript.delta") {
      this.eventQueue.push({
        type: "agent.transcript.delta",
        payload: {
          delta: event.delta,
          responseId: event.response_id,
          itemId: event.item_id ?? this.lastAssistantItemId,
        },
      });
      return;
    }

    if (type === "response.output_audio_transcript.done") {
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
      return;
    }

    if (type === "input_audio_buffer.speech_stopped") {
      this.inputSpeechActive = false;
      this.eventQueue.push({ type: "user.speech_stopped", payload: event });
      return;
    }

    if (type === "response.created") {
      this.responseActive = true;
      this.eventQueue.push({ type, payload: event });
      return;
    }

    if (type === "response.done") {
      this.responseActive = false;
      this.eventQueue.push({ type, payload: event });
      // A voice turn that reaches its output cap ends cleanly. Automatically
      // creating a second response can outlive the local playback segment and
      // sounds worse than a deliberately short answer followed by user speech.
      this.flushImmediateDirective();
      return;
    }

    if (type === "error") {
      const providerError = asRecord(event.error);
      const message =
        typeof providerError?.message === "string"
          ? providerError.message
          : "OpenAI Realtime returned an error during session setup";
      // A rejected session.update otherwise leaves initialize() waiting until
      // its timeout, hiding the actionable provider error from the caller.
      if (!this.configured) {
        this.ready.reject(new Error(`OpenAI Realtime session rejected: ${message}`));
      }
      this.eventQueue.push({ type: "provider.error", payload: event });
      return;
    }

    this.eventQueue.push({ type, payload: event });
  }

  private handleTransportError(error: Error): void {
    this.ready.reject(error);
    this.eventQueue.fail(error);
  }

  private handleClose(code: number, reason: string): void {
    this.closed = true;
    if (!this.configured) {
      this.ready.reject(
        new Error(`OpenAI Realtime socket closed before ready (${code}: ${reason})`),
      );
    }
    this.eventQueue.end();
  }

  private assertUsable(): void {
    if (!this.configured || this.closed) {
      throw new Error("OpenAI Realtime session is not ready");
    }
  }

  private handshakeStage(): string {
    if (!this.transportOpened) return "while opening the WebSocket transport";
    if (!this.configurationSent) return "while waiting for session.created";
    return "while waiting for session.updated";
  }

  private nextEventId(prefix: string): string {
    this.sequence += 1;
    return eventId(prefix, this.sequence);
  }

  private configuredLanguages(): readonly SupportedLanguage[] {
    return this.context.preferredLanguage
      ? [this.context.preferredLanguage]
      : this.config.languages;
  }

  private sequenceForInputItem(itemId: string): number {
    const existing = this.inputTurnOrder.get(itemId);
    if (existing !== undefined) return existing;
    this.inputTurnSequence += 1;
    this.inputTurnOrder.set(itemId, this.inputTurnSequence);
    return this.inputTurnSequence;
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

import type {
  ConversationSessionPort,
  StableTurn,
  SupportedLanguage,
  VoiceRuntimeEvent,
} from "../contracts.ts";
import type {
  ExotelCallObserver,
  ExotelServerSocket,
} from "../infrastructure/exotel-call-adapter.ts";
import { ExotelCallAdapter } from "../infrastructure/exotel-call-adapter.ts";
import type { PrototypeCallSession, PrototypeSystem } from "./prototype-system.ts";
import { LiveCallLatencyRecorder } from "./live-call-latency.ts";
import { PreparedCallCoordinator, type PreparedCallHandle } from "./prepared-call-coordinator.ts";
import { SerialTaskQueue } from "./serial-task-queue.ts";
import type { ConversationRuntime, SessionContext } from "../contracts.ts";

interface CompletedTurnPayload {
  turnId: string;
  transcript: string;
  turnSequence: number;
  languages?: unknown;
}

function languageHint(raw: unknown): SupportedLanguage | undefined {
  if (!Array.isArray(raw)) return undefined;
  const codes = new Set(
    raw
      .map((item) => {
        if (typeof item === "string") return item.toLowerCase();
        if (typeof item === "object" && item !== null) {
          const code = (item as Record<string, unknown>).code;
          return typeof code === "string" ? code.toLowerCase() : undefined;
        }
        return undefined;
      })
      .filter((item): item is string => item !== undefined),
  );
  const supported = [codes.has("en"), codes.has("hi"), codes.has("te")].filter(
    Boolean,
  ).length;
  if (supported > 1) return "MIXED";
  if (codes.has("en")) return "EN";
  if (codes.has("hi")) return "HI";
  if (codes.has("te")) return "TE";
  return undefined;
}

function completedTurn(payload: Record<string, unknown>): CompletedTurnPayload | undefined {
  if (
    typeof payload.turnId !== "string" ||
    typeof payload.transcript !== "string" ||
    typeof payload.turnSequence !== "number"
  ) return undefined;
  return {
    turnId: payload.turnId,
    transcript: payload.transcript.trim(),
    turnSequence: payload.turnSequence,
    ...(payload.languages === undefined ? {} : { languages: payload.languages }),
  };
}

export class LiveCallController implements ExotelCallObserver {
  private readonly conversation: ConversationSessionPort;
  private readonly workflow: PrototypeCallSession;
  private readonly latency: LiveCallLatencyRecorder;
  private readonly wallNow: () => Date;
  private readonly controlQueue = new SerialTaskQueue();
  private readonly directiveQueue = new SerialTaskQueue();
  private readonly turnWork = new Set<Promise<void>>();
  private readonly pendingTurns = new Map<number, CompletedTurnPayload | null>();
  private nextTurnSequence = 1;
  private assistantTranscript = "";
  private readonly precedingAssistantByTurnId = new Map<string, string>();
  private actionFlush: Promise<void> = Promise.resolve();
  private backgroundFailure?: unknown;
  private voiceStopped = false;
  private endScheduled = false;

  constructor(
    conversation: ConversationSessionPort,
    workflow: PrototypeCallSession,
    latency: LiveCallLatencyRecorder,
    wallNow: () => Date = () => new Date(),
  ) {
    this.conversation = conversation;
    this.workflow = workflow;
    this.latency = latency;
    this.wallNow = wallNow;
  }

  onEvent(type: string, payload: Record<string, unknown>): void {
    this.latency.onEvent(type, payload);
    if (type === "response.output_item.added") {
      this.assistantTranscript = "";
      return;
    }
    if (type === "agent.transcript.delta" && typeof payload.delta === "string") {
      this.assistantTranscript += payload.delta;
      return;
    }
    if (type === "agent.turn.completed" && typeof payload.transcript === "string") {
      this.assistantTranscript = payload.transcript.trim();
      return;
    }
    if (type === "user.speech_started" && typeof payload.item_id === "string") {
      const preceding = this.assistantTranscript.trim();
      if (preceding) this.precedingAssistantByTurnId.set(payload.item_id, preceding);
      return;
    }
    if (type === "user.turn.completed") {
      const turn = completedTurn(payload);
      if (!turn) return;
      this.pendingTurns.set(
        turn.turnSequence,
        turn.transcript.length === 0 ? null : turn,
      );
      this.controlQueue.enqueue(() => this.drainCompletedTurns());
      return;
    }
    if (
      type === "user.transcription.failed" &&
      typeof payload.turnSequence === "number"
    ) {
      this.pendingTurns.set(payload.turnSequence, null);
      this.controlQueue.enqueue(() => this.drainCompletedTurns());
      return;
    }
    if (type === "telephony.stopped") this.scheduleEnd();
  }

  scheduleEnd(): void {
    if (this.endScheduled) return;
    this.endScheduled = true;
    this.voiceStopped = true;
    this.controlQueue.enqueue(async () => {
      await this.workflow.endAndWait();
    });
  }

  async idle(): Promise<void> {
    await this.controlQueue.idle();
    await Promise.all([...this.turnWork]);
    await this.directiveQueue.idle();
    await this.actionFlush;
    await this.workflow.idle();
    if (this.backgroundFailure) throw this.backgroundFailure;
  }

  private async drainCompletedTurns(): Promise<void> {
    while (true) {
      if (!this.pendingTurns.has(this.nextTurnSequence)) return;
      const completed = this.pendingTurns.get(this.nextTurnSequence) ?? null;
      this.pendingTurns.delete(this.nextTurnSequence);
      this.nextTurnSequence += 1;
      if (completed === null) continue;
      const detectedLanguage = languageHint(completed.languages);
      const precedingAssistantText = this.precedingAssistantByTurnId.get(
        completed.turnId,
      );
      this.precedingAssistantByTurnId.delete(completed.turnId);
      const turn: StableTurn = {
        turnId: completed.turnId,
        text: completed.transcript,
        occurredAt: this.wallNow().toISOString(),
        ...(precedingAssistantText === undefined
          ? {}
          : { precedingAssistantText }),
        ...(detectedLanguage === undefined
          ? {}
          : { languageHint: detectedLanguage }),
      };
      this.scheduleTurnProcessing(turn);
    }
  }

  private scheduleTurnProcessing(turn: StableTurn): void {
    const work = this.workflow.submitStableTurnAndWait(turn).then(async () => {
      await this.directiveQueue.enqueueAndWait(() => this.flushDirectives());
      this.scheduleActionDirectiveFlush();
    }).catch((error: unknown) => {
      this.backgroundFailure ??= error;
    });
    this.turnWork.add(work);
    void work.finally(() => this.turnWork.delete(work));
  }

  private scheduleActionDirectiveFlush(): void {
    const flush = this.actionFlush.then(async () => {
      await this.workflow.actionsIdle();
      await this.directiveQueue.enqueueAndWait(() => this.flushDirectives());
    });
    this.actionFlush = flush.catch((error: unknown) => {
      this.backgroundFailure ??= error;
    });
  }

  private async flushDirectives(): Promise<void> {
    const directives = this.workflow.takeDirectives();
    if (this.voiceStopped) return;
    for (const directive of directives) {
      if (directive.delivery !== "POST_CALL") {
        await this.conversation.sendDirective(directive);
      }
    }
  }
}

export class LiveCallHandle {
  readonly adapter: ExotelCallAdapter;
  readonly controller: LiveCallController;
  readonly latency: LiveCallLatencyRecorder;

  constructor(
    adapter: ExotelCallAdapter,
    controller: LiveCallController,
    latency: LiveCallLatencyRecorder,
  ) {
    this.adapter = adapter;
    this.controller = controller;
    this.latency = latency;
  }

  receive(rawMessage: string): void {
    this.adapter.receive(rawMessage);
  }

  async idle(): Promise<void> {
    await this.adapter.idle();
    await this.controller.idle();
  }

  async close(): Promise<void> {
    this.controller.scheduleEnd();
    await this.adapter.close();
    await this.controller.idle();
  }
}

interface PreparedWorkflow {
  context: SessionContext;
  prewarmMs: number;
}

export class LiveCallCoordinator {
  private readonly voice: PreparedCallCoordinator;
  private readonly workflows: PrototypeSystem;
  private readonly monotonicNow: () => number;
  private readonly wallNow: () => Date;
  private readonly prepared = new Map<string, PreparedWorkflow>();

  constructor(
    runtime: ConversationRuntime,
    workflows: PrototypeSystem,
    options: {
      monotonicNow?: () => number;
      wallNow?: () => Date;
      tokenFactory?: () => string;
      ttlMs?: number;
    } = {},
  ) {
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => new Date());
    this.workflows = workflows;
    this.voice = new PreparedCallCoordinator(runtime, {
      ...(options.tokenFactory === undefined
        ? {}
        : { tokenFactory: options.tokenFactory }),
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      now: () => this.wallNow().getTime(),
    });
  }

  async prepare(context: SessionContext): Promise<PreparedCallHandle> {
    const startedAt = this.monotonicNow();
    const handle = await this.voice.prepare(context);
    this.prepared.set(handle.token, {
      context,
      prewarmMs: this.monotonicNow() - startedAt,
    });
    return handle;
  }

  async attach(token: string, socket: ExotelServerSocket): Promise<LiveCallHandle> {
    const prepared = this.prepared.get(token);
    if (!prepared) throw new Error("Live call token is invalid or already used");
    this.prepared.delete(token);
    const conversation = await this.voice.claim(token);
    let workflow: PrototypeCallSession;
    try {
      workflow = await this.workflows.startCall(prepared.context.callId);
    } catch (error) {
      await conversation.close();
      throw error;
    }
    const latency = new LiveCallLatencyRecorder(this.monotonicNow, this.wallNow);
    latency.recordPrewarm(prepared.prewarmMs);
    const controller = new LiveCallController(
      conversation,
      workflow,
      latency,
      this.wallNow,
    );
    const adapter = new ExotelCallAdapter(socket, conversation, {
      observer: controller,
    });
    return new LiveCallHandle(adapter, controller, latency);
  }

  async abort(token: string): Promise<void> {
    this.prepared.delete(token);
    await this.voice.abort(token);
  }
}

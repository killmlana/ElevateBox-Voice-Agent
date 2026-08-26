import type {
  CandidateContext,
} from "./message-composer.ts";
import type {
  Clock,
  ConversationDirective,
  LeadUnderstandingPort,
  LeadState,
  MessagingAdapter,
  NormalizedEvent,
  SchedulerAdapter,
  StableTurn,
} from "../contracts.ts";
import { InMemoryEventStore } from "../infrastructure/event-store.ts";
import type { NormalizedEventSink } from "../infrastructure/event-store.ts";
import { ActionManager } from "./action-manager.ts";
import { ConversationOrchestrator } from "./conversation-orchestrator.ts";
import { MessageComposer } from "./message-composer.ts";
import { SerialTaskQueue } from "./serial-task-queue.ts";
import { Supervisor } from "./supervisor.ts";

export interface PrototypeConfig {
  leadPhone: string;
  candidate: CandidateContext;
}

export class PrototypeCallSession {
  readonly callId: string;
  private readonly supervisor: Supervisor;
  private readonly actionManager: ActionManager;
  private readonly actionQueue = new SerialTaskQueue();
  private readonly turnTasks = new Set<Promise<void>>();
  private turnFailure: unknown;
  private ended = false;
  private endPromise: Promise<void> | undefined;

  constructor(callId: string, supervisor: Supervisor, actionManager: ActionManager) {
    this.callId = callId;
    this.supervisor = supervisor;
    this.actionManager = actionManager;
  }

  submitStableTurn(turn: StableTurn): void {
    if (this.ended) throw new Error("Cannot submit a turn after call end");
    void this.submitStableTurnAndWait(turn).catch(() => undefined);
  }

  submitStableTurnAndWait(turn: StableTurn): Promise<void> {
    if (this.ended) {
      return Promise.reject(new Error("Cannot submit a turn after call end"));
    }
    const task = (async () => {
      const result = await this.supervisor.processTurn(this.callId, turn);
      for (const command of result.commands) this.enqueueAction(command);
    })();
    this.turnTasks.add(task);
    void task.catch((error: unknown) => {
      this.turnFailure ??= error;
    }).finally(() => {
      this.turnTasks.delete(task);
    });
    return task;
  }

  end(): void {
    void this.endAndWait().catch(() => undefined);
  }

  async endAndWait(): Promise<void> {
    if (this.endPromise) return this.endPromise;
    this.ended = true;
    this.endPromise = (async () => {
      await this.waitForTurns();
      const commands = await this.supervisor.endCall(this.callId);
      for (const command of commands) this.enqueueAction(command);
      await this.actionQueue.idle();
    })();
    return this.endPromise;
  }

  async idle(): Promise<void> {
    await this.waitForTurns();
    await this.actionQueue.idle();
    if (this.endPromise) await this.endPromise;
    if (this.turnFailure) {
      const error = this.turnFailure;
      this.turnFailure = undefined;
      throw error;
    }
  }

  async actionsIdle(): Promise<void> {
    await this.actionQueue.idle();
  }

  state(): LeadState {
    return this.supervisor.state(this.callId);
  }

  takeDirectives(): ConversationDirective[] {
    return this.supervisor.takeDirectives(this.callId);
  }

  private enqueueAction(command: Parameters<ActionManager["execute"]>[0]): void {
    this.actionQueue.enqueue(async () => {
      await this.actionManager.execute(command, async (event) => {
        await this.supervisor.recordActionLifecycle(event);
      });
    });
  }

  private async waitForTurns(): Promise<void> {
    while (this.turnTasks.size > 0) {
      await Promise.allSettled([...this.turnTasks]);
    }
  }
}

export class PrototypeSystem {
  private readonly events: InMemoryEventStore;
  private readonly supervisor: Supervisor;
  private readonly actionManager: ActionManager;

  constructor(
    config: PrototypeConfig,
    clock: Clock,
    messaging: MessagingAdapter,
    scheduler: SchedulerAdapter,
    understanding: LeadUnderstandingPort,
    eventSink?: NormalizedEventSink,
  ) {
    this.events = new InMemoryEventStore(clock, eventSink);
    const orchestrator = new ConversationOrchestrator();
    this.supervisor = new Supervisor(
      clock,
      this.events,
      orchestrator,
      understanding,
    );
    const composer = new MessageComposer(config.candidate, config.leadPhone);
    this.actionManager = new ActionManager(
      messaging,
      scheduler,
      composer,
      config.leadPhone,
    );
  }

  async startCall(callId: string): Promise<PrototypeCallSession> {
    await this.supervisor.startCall(callId);
    return new PrototypeCallSession(callId, this.supervisor, this.actionManager);
  }

  eventsFor(callId: string): NormalizedEvent<unknown>[] {
    return this.events.all(callId);
  }
}

import type {
  ActionCommand,
  ActionResult,
  LeadState,
  MessagingAdapter,
  SchedulerAdapter,
} from "../contracts.ts";
import { MessageComposer } from "./message-composer.ts";

export interface ActionLifecycleEvent {
  type: "action.started" | "action.succeeded" | "action.failed";
  command: ActionCommand;
  attempt: number;
  externalId?: string;
  error?: string;
}

export type ActionEventSink = (event: ActionLifecycleEvent) => Promise<void>;

export class ActionManager {
  private readonly messaging: MessagingAdapter;
  private readonly scheduler: SchedulerAdapter;
  private readonly composer: MessageComposer;
  private readonly leadPhone: string;
  private readonly completed = new Map<string, ActionResult>();
  private readonly inFlight = new Map<string, Promise<ActionResult>>();

  constructor(
    messaging: MessagingAdapter,
    scheduler: SchedulerAdapter,
    composer: MessageComposer,
    leadPhone: string,
  ) {
    this.messaging = messaging;
    this.scheduler = scheduler;
    this.composer = composer;
    this.leadPhone = leadPhone;
  }

  execute(command: ActionCommand, sink: ActionEventSink): Promise<ActionResult> {
    const completed = this.completed.get(command.idempotencyKey);
    if (completed) return Promise.resolve(completed);
    const existing = this.inFlight.get(command.idempotencyKey);
    if (existing) return existing;

    const execution = this.run(command, sink).finally(() => {
      this.inFlight.delete(command.idempotencyKey);
    });
    this.inFlight.set(command.idempotencyKey, execution);
    return execution;
  }

  private async run(command: ActionCommand, sink: ActionEventSink): Promise<ActionResult> {
    let lastError = "Action failed";
    for (let attempt = 1; attempt <= command.maxAttempts; attempt += 1) {
      await sink({ type: "action.started", command, attempt });
      try {
        const externalId = await this.dispatch(command);
        const result: ActionResult = {
          command,
          status: "SUCCEEDED",
          attempt,
          externalId,
        };
        this.completed.set(command.idempotencyKey, result);
        await sink({
          type: "action.succeeded",
          command,
          attempt,
          externalId,
        });
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt === command.maxAttempts) {
          const result: ActionResult = {
            command,
            status: "FAILED",
            attempt,
            error: lastError,
          };
          await sink({
            type: "action.failed",
            command,
            attempt,
            error: lastError,
          });
          return result;
        }
      }
    }
    throw new Error(lastError);
  }

  private async dispatch(command: ActionCommand): Promise<string> {
    if (command.kind === "BOOK_CALLBACK") {
      const resolvedAt = String(command.payload.resolvedAt ?? "");
      const rawTime = String(command.payload.rawTime ?? "");
      if (!resolvedAt || !rawTime) throw new Error("Callback command is incomplete");
      const result = await this.scheduler.book({
        leadPhone: this.leadPhone,
        scheduledAt: resolvedAt,
        rawTime,
        idempotencyKey: command.idempotencyKey,
      });
      return result.externalId;
    }

    const state = command.payload.state as LeadState | undefined;
    if (!state) throw new Error("Message command is missing LeadState");
    const message = command.kind === "SEND_HOT_DETAILS"
      ? this.composer.hotDetails(state, command.idempotencyKey)
      : command.kind === "SEND_COLD_BROCHURE"
        ? this.composer.coldBrochure(state, command.idempotencyKey)
        : this.composer.finalFollowup(state, command.idempotencyKey);
    const result = await this.messaging.send(message);
    return result.externalId;
  }
}

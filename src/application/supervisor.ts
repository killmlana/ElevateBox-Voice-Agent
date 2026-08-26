import type {
  ActionCommand,
  ConversationDirective,
  LeadUnderstandingPort,
  LeadState,
  StableTurn,
} from "../contracts.ts";
import { resolveCallbackTime } from "../domain/callback-time.ts";
import { DeterministicLeadClassifier } from "../domain/classifier.ts";
import {
  applyLeadUpdate,
  createLeadState,
  markActionSucceeded,
} from "../domain/lead-state.ts";
import { LeadPolicy } from "../domain/policy.ts";
import { addDeterministicNegativeSignals } from "../domain/negative-intent.ts";
import type { Clock } from "../contracts.ts";
import { InMemoryEventStore } from "../infrastructure/event-store.ts";
import type { ActionLifecycleEvent } from "./action-manager.ts";
import { ConversationOrchestrator } from "./conversation-orchestrator.ts";

interface CallContext {
  state: LeadState;
  seenTurnIds: Set<string>;
  requestedActionKinds: Set<string>;
  analysisApplyTail: Promise<void>;
}

export interface TurnProcessingResult {
  commands: ActionCommand[];
  duplicate: boolean;
}

export class Supervisor {
  private readonly clock: Clock;
  private readonly events: InMemoryEventStore;
  private readonly orchestrator: ConversationOrchestrator;
  private readonly understanding: LeadUnderstandingPort;
  private readonly classifier = new DeterministicLeadClassifier();
  private readonly policy = new LeadPolicy();
  private readonly calls = new Map<string, CallContext>();

  constructor(
    clock: Clock,
    events: InMemoryEventStore,
    orchestrator: ConversationOrchestrator,
    understanding: LeadUnderstandingPort,
  ) {
    this.clock = clock;
    this.events = events;
    this.orchestrator = orchestrator;
    this.understanding = understanding;
  }

  async startCall(callId: string): Promise<LeadState> {
    if (this.calls.has(callId)) throw new Error(`Call already exists: ${callId}`);
    const now = this.clock.now().toISOString();
    let state = createLeadState(callId, now);
    await this.events.append({ callId, type: "call.created", payload: { state: "CREATED" } });
    state = { ...state, callState: "READY", updatedAt: now };
    await this.events.append({ callId, type: "call.ready", payload: { state: "READY" } });
    state = { ...state, callState: "ACTIVE", updatedAt: now };
    await this.events.append({ callId, type: "call.connected", payload: { state: "ACTIVE" } });
    this.calls.set(callId, {
      state,
      seenTurnIds: new Set(),
      requestedActionKinds: new Set(),
      analysisApplyTail: Promise.resolve(),
    });
    return state;
  }

  async processTurn(callId: string, turn: StableTurn): Promise<TurnProcessingResult> {
    const context = this.requireCall(callId);
    if (context.state.callState !== "ACTIVE") {
      throw new Error(`Cannot process a turn while call is ${context.state.callState}`);
    }
    if (context.seenTurnIds.has(turn.turnId)) {
      await this.events.append({
        callId,
        type: "turn.duplicate_ignored",
        payload: { turnId: turn.turnId },
        sourceTurnIds: [turn.turnId],
      });
      return { commands: [], duplicate: true };
    }
    context.seenTurnIds.add(turn.turnId);

    // Model extraction may run concurrently, but reserve an ordered state-apply
    // slot before the first await so later turns cannot overwrite earlier ones.
    const applyAfter = context.analysisApplyTail;
    let releaseApply!: () => void;
    context.analysisApplyTail = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });

    let reachedApplySlot = false;
    try {
      return await this.processReservedTurn(context, callId, turn, applyAfter, () => {
        reachedApplySlot = true;
      });
    } finally {
      if (!reachedApplySlot) await applyAfter;
      releaseApply();
    }
  }

  private async processReservedTurn(
    context: CallContext,
    callId: string,
    turn: StableTurn,
    applyAfter: Promise<void>,
    markApplySlotReached: () => void,
  ): Promise<TurnProcessingResult> {

    await this.events.append({
      callId,
      type: "turn.completed",
      payload: {
        text: turn.text,
        languageHint: turn.languageHint ?? "UNKNOWN",
        ...(turn.precedingAssistantText === undefined
          ? {}
          : { precedingAssistantText: turn.precedingAssistantText }),
      },
      sourceTurnIds: [turn.turnId],
    });

    const analysisState = context.state;
    const analysisStartedAt = performance.now();
    await this.events.append({
      callId,
      type: "lead.analysis.started",
      payload: { turnId: turn.turnId },
      sourceTurnIds: [turn.turnId],
    });
    let update;
    try {
      update = await this.understanding.understand({
        turn,
        currentState: analysisState,
      });
      update = addDeterministicNegativeSignals(update, turn.turnId, turn.text);
    } catch (error) {
      const analysisDurationMs = performance.now() - analysisStartedAt;
      await this.events.append({
        callId,
        type: "lead.analysis.failed",
        payload: {
          turnId: turn.turnId,
          durationMs: analysisDurationMs,
          error: error instanceof Error ? error.message : String(error),
        },
        sourceTurnIds: [turn.turnId],
      });
      await applyAfter;
      markApplySlotReached();
      return { commands: [], duplicate: false };
    }
    const analysisDurationMs = performance.now() - analysisStartedAt;
    await this.events.append({
      callId,
      type: "lead.analysis.completed",
      payload: {
        turnId: turn.turnId,
        durationMs: analysisDurationMs,
      },
      sourceTurnIds: [turn.turnId],
    });
    const applyWaitStartedAt = performance.now();
    await applyAfter;
    markApplySlotReached();
    const orderedApplyWaitMs = performance.now() - applyWaitStartedAt;
    const previous = context.state;
    let current = applyLeadUpdate(previous, update, this.clock.now().toISOString());

    if (update.callbackPhrase) {
      const resolution = resolveCallbackTime(update.callbackPhrase.value, this.clock.now());
      current = {
        ...current,
        callback: {
          requested: resolution.status !== "not_requested",
          rawTime: update.callbackPhrase.value,
          ...(resolution.resolvedAt ? { resolvedAt: resolution.resolvedAt } : {}),
          needsClarification: resolution.status === "needs_clarification",
          booked: current.callback.booked,
        },
      };
      await this.events.append({
        callId,
        type: resolution.status === "resolved"
          ? "callback.time_resolved"
          : "callback.time_needs_clarification",
        payload: resolution,
        sourceTurnIds: update.callbackPhrase.sourceTurnIds,
      });
    }

    const classification = this.classifier.classify(current);
    current = {
      ...current,
      intent: classification.intent,
      intentScore: classification.score,
      intentScoreBreakdown: classification.scoreBreakdown,
      intentConfidence: classification.confidence,
      intentEvidenceTurnIds: classification.evidenceTurnIds,
      updatedAt: this.clock.now().toISOString(),
    };
    context.state = current;

    await this.events.append({
      callId,
      type: "lead.state.updated",
      payload: { state: current },
      sourceTurnIds: [turn.turnId],
    });
    await this.events.append({
      callId,
      type: "lead.classification.evaluated",
      payload: classification,
      sourceTurnIds: classification.evidenceTurnIds,
    });
    if (previous.intent !== current.intent) {
      await this.events.append({
        callId,
        type: "lead.classification.changed",
        payload: classification,
        sourceTurnIds: classification.evidenceTurnIds,
      });
    }

    const decision = this.policy.evaluate({
      previous,
      current,
      update,
      requestedActionKinds: context.requestedActionKinds,
      now: this.clock.now().toISOString(),
    });
    for (const command of decision.commands) {
      context.requestedActionKinds.add(command.kind);
      await this.events.append({
        callId,
        type: "action.requested",
        payload: {
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          kind: command.kind,
        },
        sourceTurnIds: [turn.turnId],
      });
    }
    for (const item of decision.directives) await this.publishDirective(item);
    await this.events.append({
      callId,
      type: "lead.analysis.applied",
      payload: {
        turnId: turn.turnId,
        analysisDurationMs,
        orderedApplyWaitMs,
        totalDurationMs: performance.now() - analysisStartedAt,
      },
      sourceTurnIds: [turn.turnId],
    });
    return { commands: decision.commands, duplicate: false };
  }

  async recordActionLifecycle(event: ActionLifecycleEvent): Promise<void> {
    const context = this.requireCall(event.command.callId);
    const payload = {
      commandId: event.command.commandId,
      idempotencyKey: event.command.idempotencyKey,
      kind: event.command.kind,
      attempt: event.attempt,
      ...(event.externalId ? { externalId: event.externalId } : {}),
      ...(event.error ? { error: event.error } : {}),
    };
    await this.events.append({
      callId: event.command.callId,
      type: event.type,
      payload,
    });

    if (event.type === "action.succeeded") {
      context.state = markActionSucceeded(
        context.state,
        event.command.kind,
        this.clock.now().toISOString(),
      );
      await this.events.append({
        callId: event.command.callId,
        type: "lead.state.updated",
        payload: { state: context.state },
      });
      if (
        context.state.callState === "ACTIVE" &&
        event.command.kind !== "SEND_FINAL_FOLLOWUP"
      ) {
        await this.publishDirective({
          directiveId: `${event.command.commandId}:success`,
          callId: event.command.callId,
          intent: "CONFIRM_ACTION_SUCCESS",
          priority: 2,
          delivery: "IMMEDIATE_IF_IDLE",
          data: {
            kind: event.command.kind,
            externalId: event.externalId ?? "",
          },
        });
      }
    }

    if (event.type === "action.failed" && context.state.callState === "ACTIVE") {
      await this.publishDirective({
        directiveId: `${event.command.commandId}:failed`,
        callId: event.command.callId,
        intent: "REPORT_ACTION_FAILURE",
        priority: 1,
        delivery: "IMMEDIATE_IF_IDLE",
        data: { kind: event.command.kind, error: event.error ?? "Unknown provider error" },
      });
    }
  }

  async endCall(callId: string): Promise<ActionCommand[]> {
    const context = this.requireCall(callId);
    if (context.state.callState === "ENDED") return [];
    context.state = {
      ...context.state,
      callState: "ENDED",
      updatedAt: this.clock.now().toISOString(),
    };
    await this.events.append({
      callId,
      type: "call.ended",
      payload: { state: "ENDED" },
    });
    await this.events.append({
      callId,
      type: "lead.state.updated",
      payload: { state: context.state },
    });

    if (
      context.state.actions.finalFollowupSent ||
      context.requestedActionKinds.has("SEND_FINAL_FOLLOWUP")
    ) return [];

    const command: ActionCommand = {
      commandId: `${callId}:send-final-followup`,
      idempotencyKey: `${callId}:SEND_FINAL_FOLLOWUP:v1`,
      callId,
      kind: "SEND_FINAL_FOLLOWUP",
      payload: { state: context.state },
      maxAttempts: 2,
    };
    context.requestedActionKinds.add(command.kind);
    await this.events.append({
      callId,
      type: "action.requested",
      payload: {
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        kind: command.kind,
      },
    });
    return [command];
  }

  state(callId: string): LeadState {
    return structuredClone(this.requireCall(callId).state);
  }

  takeDirectives(callId: string): ConversationDirective[] {
    return this.orchestrator.take(callId);
  }

  private async publishDirective(item: ConversationDirective): Promise<void> {
    if (!this.orchestrator.enqueue(item)) return;
    await this.events.append({
      callId: item.callId,
      type: "conversation.directive",
      payload: item,
    });
  }

  private requireCall(callId: string): CallContext {
    const context = this.calls.get(callId);
    if (!context) throw new Error(`Unknown call: ${callId}`);
    return context;
  }
}

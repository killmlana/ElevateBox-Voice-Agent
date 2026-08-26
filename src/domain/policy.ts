import type {
  ActionCommand,
  ConversationDirective,
  ExtractedLeadUpdate,
  LeadState,
} from "../contracts.ts";

export interface PolicyContext {
  previous: LeadState;
  current: LeadState;
  update: ExtractedLeadUpdate;
  requestedActionKinds: ReadonlySet<string>;
  now: string;
}

export interface PolicyDecision {
  commands: ActionCommand[];
  directives: ConversationDirective[];
}

function hasSignal(update: ExtractedLeadUpdate, value: string): boolean {
  return update.buyingSignals.some((signal) => signal.value === value);
}

function directive(
  state: LeadState,
  intent: ConversationDirective["intent"],
  suffix: string,
  data: Record<string, unknown>,
  priority: 1 | 2 | 3 = 2,
): ConversationDirective {
  return {
    directiveId: `${state.callId}:${intent}:${suffix}`,
    callId: state.callId,
    intent,
    priority,
    delivery: "NEXT_NATURAL_TURN",
    data,
  };
}

export class LeadPolicy {
  evaluate(context: PolicyContext): PolicyDecision {
    const { previous, current, update, requestedActionKinds, now } = context;
    const commands: ActionCommand[] = [];
    const directives: ConversationDirective[] = [];

    if (current.intent !== previous.intent) {
      directives.push(
        directive(current, "INTENT_UPDATED", `${current.intent}:${current.updatedAt}`, {
          intent: current.intent,
          confidence: current.intentConfidence,
          evidenceTurnIds: current.intentEvidenceTurnIds,
        }, 3),
      );
    }

    const hotMessageRequested = requestedActionKinds.has("SEND_HOT_DETAILS");
    if (
      current.intent === "HOT" &&
      hasSignal(update, "send_details") &&
      !current.actions.hotWhatsappSent &&
      !hotMessageRequested
    ) {
      commands.push({
        commandId: `${current.callId}:send-hot-details`,
        idempotencyKey: `${current.callId}:SEND_HOT_DETAILS:v1`,
        callId: current.callId,
        kind: "SEND_HOT_DETAILS",
        payload: { state: current, requestedAt: now },
        maxAttempts: 2,
      });
    } else if (
      current.intent === "HOT" &&
      previous.intent !== "HOT" &&
      !current.actions.hotWhatsappSent &&
      !hotMessageRequested
    ) {
      directives.push(
        directive(current, "ASK_SEND_PERMISSION", current.updatedAt, {
          reason: "High intent detected without an explicit request to send details.",
        }, 1),
      );
    }

    if (current.callback.needsClarification) {
      directives.push(
        directive(current, "ASK_CALLBACK_CLARIFICATION", current.updatedAt, {
          rawTime: current.callback.rawTime,
        }, 1),
      );
    }

    if (
      current.callback.resolvedAt &&
      !current.callback.booked &&
      !requestedActionKinds.has("BOOK_CALLBACK")
    ) {
      commands.push({
        commandId: `${current.callId}:book-callback:${current.callback.resolvedAt}`,
        idempotencyKey: `${current.callId}:BOOK_CALLBACK:${current.callback.resolvedAt}`,
        callId: current.callId,
        kind: "BOOK_CALLBACK",
        payload: {
          resolvedAt: current.callback.resolvedAt,
          rawTime: current.callback.rawTime,
        },
        maxAttempts: 2,
      });
    }

    return { commands, directives };
  }
}

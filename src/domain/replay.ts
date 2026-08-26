import type { LeadState, NormalizedEvent } from "../contracts.ts";

function isLeadState(value: unknown): value is LeadState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LeadState>;
  return typeof candidate.callId === "string" && typeof candidate.callState === "string";
}

export function replayLeadState(
  callId: string,
  events: readonly NormalizedEvent<unknown>[],
): LeadState {
  let state: LeadState | undefined;
  for (const event of events) {
    if (event.callId !== callId || event.type !== "lead.state.updated") continue;
    const payload = event.payload as { state?: unknown };
    if (!isLeadState(payload.state)) {
      throw new Error(`Invalid lead.state.updated payload at event ${event.eventId}`);
    }
    state = structuredClone(payload.state);
  }
  if (!state) throw new Error(`No replayable LeadState found for call ${callId}`);
  return state;
}

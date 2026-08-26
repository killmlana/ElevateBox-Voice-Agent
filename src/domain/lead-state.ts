import type {
  ActionKind,
  Evidence,
  ExtractedLeadUpdate,
  LeadState,
  Requirement,
  SupportedLanguage,
} from "../contracts.ts";

function mergeEvidenceList<T extends string>(
  current: Evidence<T>[],
  incoming: Evidence<T>[],
): Evidence<T>[] {
  const merged = new Map(current.map((item) => [item.value.toLowerCase(), item]));
  for (const item of incoming) {
    const key = item.value.toLowerCase();
    const prior = merged.get(key);
    if (!prior) {
      merged.set(key, item);
      continue;
    }
    merged.set(key, {
      value: prior.value,
      confidence: Math.max(prior.confidence, item.confidence),
      sourceTurnIds: [...new Set([...prior.sourceTurnIds, ...item.sourceTurnIds])],
    });
  }
  return [...merged.values()];
}

function mergeRequirementEvidence(
  current: Evidence<Requirement>[],
  incoming: Evidence<Requirement>[],
): Evidence<Requirement>[] {
  const keyFor = (item: Evidence<Requirement>) => item.value.text.trim().toLowerCase();
  const merged = new Map(current.map((item) => [keyFor(item), item]));
  for (const item of incoming) {
    const key = keyFor(item);
    const prior = merged.get(key);
    if (!prior) {
      merged.set(key, item);
      continue;
    }
    merged.set(key, {
      value: item.confidence >= prior.confidence ? item.value : prior.value,
      confidence: Math.max(prior.confidence, item.confidence),
      sourceTurnIds: [...new Set([...prior.sourceTurnIds, ...item.sourceTurnIds])],
    });
  }
  return [...merged.values()];
}

function chooseLanguage(
  current: SupportedLanguage,
  incoming: SupportedLanguage | undefined,
): SupportedLanguage {
  if (!incoming || incoming === "UNKNOWN") return current;
  if (current === "UNKNOWN") return incoming;
  if (current === incoming) return current;
  return "MIXED";
}

export function createLeadState(callId: string, now: string): LeadState {
  return {
    callId,
    callState: "CREATED",
    language: "UNKNOWN",
    customerType: {
      value: "UNKNOWN",
      sourceTurnIds: [],
      confidence: 0,
    },
    locations: [],
    products: [],
    requirements: [],
    decisionMaker: {
      value: "UNKNOWN",
      sourceTurnIds: [],
      confidence: 0,
    },
    blockers: [],
    buyingSignals: [],
    negativeSignals: [],
    intent: "UNKNOWN",
    intentScore: 0,
    intentScoreBreakdown: [],
    intentConfidence: 0,
    intentEvidenceTurnIds: [],
    callback: {
      requested: false,
      needsClarification: false,
      booked: false,
    },
    actions: {
      hotWhatsappSent: false,
      coldBrochureSent: false,
      callbackBooked: false,
      finalFollowupSent: false,
    },
    updatedAt: now,
  };
}

export function applyLeadUpdate(
  state: LeadState,
  update: ExtractedLeadUpdate,
  now: string,
): LeadState {
  return {
    ...state,
    language: chooseLanguage(state.language, update.language),
    ...(update.businessDescription
      ? { businessDescription: update.businessDescription }
      : {}),
    ...(update.customerType ? { customerType: update.customerType } : {}),
    ...(update.productCount ? { productCount: update.productCount } : {}),
    ...(update.budgetInr ? { budgetInr: update.budgetInr } : {}),
    ...(update.timeline ? { timeline: update.timeline } : {}),
    ...(update.decisionMaker ? { decisionMaker: update.decisionMaker } : {}),
    locations: mergeEvidenceList(state.locations, update.locations),
    products: mergeEvidenceList(state.products, update.products),
    requirements: mergeRequirementEvidence(state.requirements, update.requirements),
    blockers: mergeEvidenceList(state.blockers, update.blockers),
    buyingSignals: mergeEvidenceList(state.buyingSignals, update.buyingSignals),
    negativeSignals: mergeEvidenceList(
      state.negativeSignals,
      update.negativeSignals,
    ),
    updatedAt: now,
  };
}

export function markActionSucceeded(
  state: LeadState,
  kind: ActionKind,
  now: string,
): LeadState {
  const actions = { ...state.actions };
  const callback = { ...state.callback };
  if (kind === "SEND_HOT_DETAILS") actions.hotWhatsappSent = true;
  if (kind === "SEND_COLD_BROCHURE") actions.coldBrochureSent = true;
  if (kind === "BOOK_CALLBACK") {
    actions.callbackBooked = true;
    callback.booked = true;
  }
  if (kind === "SEND_FINAL_FOLLOWUP") actions.finalFollowupSent = true;
  return { ...state, actions, callback, updatedAt: now };
}

export type SupportedLanguage = "EN" | "HI" | "TE" | "MIXED" | "UNKNOWN";
export type LeadIntent = "UNKNOWN" | "HOT" | "WARM" | "COLD";
export type NegativeLeadSignal =
  | "do_not_contact"
  | "not_interested"
  | "repeated_call_complaint"
  | "hostile_or_abusive";
export type CallState =
  | "CREATED"
  | "READY"
  | "DIALING"
  | "RINGING"
  | "ACTIVE"
  | "ENDING"
  | "ENDED"
  | "FAILED";

export type ActionKind =
  | "SEND_HOT_DETAILS"
  | "SEND_COLD_BROCHURE"
  | "BOOK_CALLBACK"
  | "SEND_FINAL_FOLLOWUP";

export type DirectiveIntent =
  | "ASK_SEND_PERMISSION"
  | "ASK_CALLBACK_TIME"
  | "ASK_CALLBACK_CLARIFICATION"
  | "INTENT_UPDATED"
  | "CONFIRM_ACTION_SUCCESS"
  | "REPORT_ACTION_FAILURE";

export interface AudioFrame {
  data: Uint8Array;
  sampleRateHz: 8000 | 16000 | 24000;
  encoding: "pcm16" | "pcmu";
  timestampMs: number;
}

export interface VoiceCapabilities {
  bargeIn: boolean;
  serverVad: boolean;
  nativeAudio: boolean;
  languages: readonly SupportedLanguage[];
}

export interface SessionContext {
  callId: string;
  preferredLanguage?: SupportedLanguage;
  promptVersion: string;
  leadContext?: Record<string, unknown>;
}

/** Media-free Realtime control used by the supervisor and SIP sideband. */
export interface ConversationControlSessionPort {
  startConversation(instruction?: string): Promise<void>;
  setPreferredLanguage(language: SupportedLanguage): Promise<void>;
  sendDirective(directive: ConversationDirective): Promise<void>;
  cancelOutput(): Promise<void>;
  events(): AsyncIterable<VoiceRuntimeEvent>;
  close(): Promise<void>;
}

/** Legacy media extension retained only for providers such as Exotel. */
export interface StreamingAudioConversationSessionPort
  extends ConversationControlSessionPort {
  sendAudio(frame: AudioFrame): Promise<void>;
  interruptOutput(playedAudioMs: number): Promise<void>;
}

/** @deprecated Prefer the explicit control or streaming session interface. */
export interface ConversationSessionPort
  extends StreamingAudioConversationSessionPort {}

export interface ConversationRuntime {
  readonly capabilities: VoiceCapabilities;
  createSession(
    context: SessionContext,
  ): Promise<StreamingAudioConversationSessionPort>;
}

export interface VoiceRuntimeEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface StableTurn {
  turnId: string;
  text: string;
  occurredAt: string;
  languageHint?: SupportedLanguage;
  precedingAssistantText?: string;
}

export interface Evidence<T> {
  value: T;
  sourceTurnIds: string[];
  confidence: number;
}

export type RequirementImportance = "HARD" | "SOFT" | "UNKNOWN";

export interface Requirement {
  text: string;
  importance: RequirementImportance;
}

export interface CallbackState {
  requested: boolean;
  rawTime?: string;
  resolvedAt?: string;
  proposedAt?: string;
  awaitingConfirmation: boolean;
  declinedWithoutAlternative: boolean;
  needsClarification: boolean;
  booked: boolean;
}

export interface LeadState {
  callId: string;
  callState: CallState;
  language: SupportedLanguage;
  languageLocked: boolean;
  businessDescription?: Evidence<string>;
  customerType: Evidence<"BUSINESS" | "INDIVIDUAL" | "UNKNOWN">;
  locations: Evidence<string>[];
  products: Evidence<string>[];
  productCount?: Evidence<number>;
  budgetInr?: Evidence<number>;
  timeline?: Evidence<string>;
  requirements: Evidence<Requirement>[];
  decisionMaker: Evidence<"SELF" | "OTHER" | "UNKNOWN">;
  blockers: Evidence<string>[];
  buyingSignals: Evidence<string>[];
  negativeSignals: Evidence<NegativeLeadSignal>[];
  intent: LeadIntent;
  /**
   * True once the lead has reached HOT at any point in the call. Consent to
   * receive details outlives the tier that prompted us to ask for it, so the
   * send gate stays open after a later blocker drops intent back to WARM.
   */
  hotPeaked: boolean;
  intentScore: number;
  intentScoreBreakdown: Array<{
    factor: string;
    delta: number;
  }>;
  intentConfidence: number;
  intentEvidenceTurnIds: string[];
  callback: CallbackState;
  actions: {
    hotWhatsappSent: boolean;
    coldBrochureSent: boolean;
    callbackBooked: boolean;
    finalFollowupSent: boolean;
  };
  updatedAt: string;
}

export interface ExtractedLeadUpdate {
  language?: SupportedLanguage;
  businessDescription?: Evidence<string>;
  customerType?: Evidence<"BUSINESS" | "INDIVIDUAL" | "UNKNOWN">;
  locations: Evidence<string>[];
  products: Evidence<string>[];
  productCount?: Evidence<number>;
  budgetInr?: Evidence<number>;
  timeline?: Evidence<string>;
  requirements: Evidence<Requirement>[];
  decisionMaker?: Evidence<"SELF" | "OTHER" | "UNKNOWN">;
  blockers: Evidence<string>[];
  buyingSignals: Evidence<string>[];
  negativeSignals: Evidence<NegativeLeadSignal>[];
  callbackPhrase?: Evidence<string>;
}

export interface LeadUnderstandingInput {
  turn: StableTurn;
  currentState: LeadState;
}

export interface LeadUnderstandingPort {
  understand(input: LeadUnderstandingInput): Promise<ExtractedLeadUpdate>;
}

export interface IntentClassification {
  intent: LeadIntent;
  score: number;
  scoreBreakdown: Array<{
    factor: string;
    delta: number;
  }>;
  confidence: number;
  evidenceTurnIds: string[];
  rationale: string;
}

export interface CallbackResolution {
  status: "not_requested" | "resolved" | "needs_clarification";
  rawTime?: string;
  resolvedAt?: string;
  proposedAt?: string;
  reason?: string;
}

export interface CallbackTimeRequest {
  /** The lead's own words, e.g. "kal shaam" or "Monday evening". */
  rawTime: string;
  /** Anchor for relative phrases. */
  now: Date;
  languageHint?: SupportedLanguage;
}

/**
 * Turns a spoken callback phrase into an instant. Implementations may call a
 * model, but must never leave the caller without an answer: fall back to a
 * deterministic parse rather than propagating an upstream failure.
 */
export interface CallbackTimeResolverPort {
  resolve(request: CallbackTimeRequest): Promise<CallbackResolution>;
}

export interface ConversationDirective {
  directiveId: string;
  callId: string;
  intent: DirectiveIntent;
  priority: 1 | 2 | 3;
  delivery: "IMMEDIATE_IF_IDLE" | "NEXT_NATURAL_TURN" | "POST_CALL";
  expiresAt?: string;
  data: Record<string, unknown>;
}

export interface ActionCommand {
  commandId: string;
  idempotencyKey: string;
  callId: string;
  kind: ActionKind;
  payload: Record<string, unknown>;
  maxAttempts: number;
}

export interface ActionResult {
  command: ActionCommand;
  status: "SUCCEEDED" | "FAILED";
  attempt: number;
  externalId?: string;
  simulated?: boolean;
  error?: string;
}

export interface NormalizedEvent<T = Record<string, unknown>> {
  eventId: string;
  callId: string;
  seq: number;
  type: string;
  occurredAt: string;
  sourceTurnIds: string[];
  payload: T;
}

export interface OutgoingMessage {
  to: string;
  body: string;
  attachments: string[];
  idempotencyKey: string;
  consent?: "EXPLICIT_WHATSAPP_OPT_IN";
}

export interface CallbackBooking {
  leadPhone: string;
  scheduledAt: string;
  rawTime: string;
  idempotencyKey: string;
  preferredLanguage?: SupportedLanguage;
}

export interface MessagingAdapter {
  send(message: OutgoingMessage): Promise<{
    externalId: string;
    simulated?: boolean;
  }>;
}

export interface SchedulerAdapter {
  book(booking: CallbackBooking): Promise<{
    externalId: string;
    simulated?: boolean;
  }>;
}

export type OutboundCallProvider = "asterisk-sip" | "exotel";

/** A server-issued capability returned only after the selected AI leg is ready. */
export interface ReadyPreparedCall {
  ready: true;
  callId: string;
  token: string;
  expiresAt: string;
  provider: OutboundCallProvider;
}

/**
 * Internal legacy capability. streamUrl is never returned by the public
 * prepare endpoint and exists only while the Exotel rollback path is enabled.
 */
export interface ReadySingleUseMedia
  extends Omit<ReadyPreparedCall, "provider"> {
  provider?: "exotel";
  streamUrl: string;
}

export interface OutboundDialRequest {
  media: ReadyPreparedCall | ReadySingleUseMedia;
  to: string;
  idempotencyKey: string;
  timeLimitSeconds?: number;
}

export interface OutboundDialResult {
  providerCallId: string;
  status: string;
  simulated: boolean;
}

export interface OutboundDialAdapter {
  dial(request: OutboundDialRequest): Promise<OutboundDialResult>;
}

export type SipCallLifecycleState =
  | "PREPARING_AI"
  | "AI_READY"
  | "DIALING_LEAD"
  | "BRIDGED"
  | "ENDED"
  | "FAILED";

/** Provider-neutral telephony lifecycle observer used by both call paths. */
export interface TelephonyLifecycleObserver {
  onEvent(type: string, payload: Record<string, unknown>): void;
}

export interface Clock {
  now(): Date;
}

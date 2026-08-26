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
  | "BOOK_CALLBACK"
  | "SEND_FINAL_FOLLOWUP";

export type DirectiveIntent =
  | "ASK_SEND_PERMISSION"
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

export interface ConversationSessionPort {
  startConversation(instruction?: string): Promise<void>;
  setPreferredLanguage(language: SupportedLanguage): Promise<void>;
  sendAudio(frame: AudioFrame): Promise<void>;
  sendDirective(directive: ConversationDirective): Promise<void>;
  interruptOutput(playedAudioMs: number): Promise<void>;
  events(): AsyncIterable<VoiceRuntimeEvent>;
  close(): Promise<void>;
}

export interface ConversationRuntime {
  readonly capabilities: VoiceCapabilities;
  createSession(context: SessionContext): Promise<ConversationSessionPort>;
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
  needsClarification: boolean;
  booked: boolean;
}

export interface LeadState {
  callId: string;
  callState: CallState;
  language: SupportedLanguage;
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
  reason?: string;
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
}

export interface CallbackBooking {
  leadPhone: string;
  scheduledAt: string;
  rawTime: string;
  idempotencyKey: string;
}

export interface MessagingAdapter {
  send(message: OutgoingMessage): Promise<{ externalId: string }>;
}

export interface SchedulerAdapter {
  book(booking: CallbackBooking): Promise<{ externalId: string }>;
}

export interface Clock {
  now(): Date;
}

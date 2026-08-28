import type {
  Evidence,
  ExtractedLeadUpdate,
  LeadUnderstandingInput,
  LeadUnderstandingPort,
  Requirement,
  RequirementImportance,
  NegativeLeadSignal,
  SupportedLanguage,
} from "../contracts.ts";

export interface StructuredLeadPatchClient {
  generate(input: {
    turnId: string;
    instruction: string;
    turnText: string;
    precedingAssistantText?: string;
    languageHint?: SupportedLanguage;
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<unknown>;
}

export const LEAD_PATCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    language: { enum: ["EN", "HI", "TE", "MIXED", "UNKNOWN", null] },
    businessDescription: {
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    },
    customerType: { enum: ["BUSINESS", "INDIVIDUAL", "UNKNOWN", null] },
    locations: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    products: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    productCount: {
      anyOf: [{ type: "number", minimum: 0 }, { type: "null" }],
    },
    budgetInr: {
      anyOf: [{ type: "number", minimum: 0 }, { type: "null" }],
    },
    timeline: {
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    },
    requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "importance"],
        properties: {
          text: { type: "string", minLength: 1 },
          importance: { enum: ["HARD", "SOFT", "UNKNOWN"] },
        },
      },
    },
    decisionMaker: { enum: ["SELF", "OTHER", "UNKNOWN", null] },
    blockers: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    buyingSignals: {
      type: "array",
      items: {
        enum: [
          "send_details",
          "start_soon",
          "pricing_interest",
          "clear_need",
        ],
      },
    },
    negativeSignals: {
      type: "array",
      items: {
        enum: [
          "do_not_contact",
          "not_interested",
          "repeated_call_complaint",
          "hostile_or_abusive",
        ],
      },
    },
    callbackPhrase: {
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "language",
    "businessDescription",
    "customerType",
    "locations",
    "products",
    "productCount",
    "budgetInr",
    "timeline",
    "requirements",
    "decisionMaker",
    "blockers",
    "buyingSignals",
    "negativeSignals",
    "callbackPhrase",
    "confidence",
  ],
};

const INSTRUCTION = `Extract a compact lead-state patch from only the latest stable lead turn in an outbound e-commerce website sales call.
Preserve the lead's meaning and do not invent facts. The preceding assistant text is context only: use it to resolve short or elliptical lead answers such as "yes", "no", or "around fifty", but never extract an assistant claim as lead evidence.
Use only the buying-signal tags send_details, start_soon, pricing_interest, and clear_need. Set send_details only when the lead explicitly asks or agrees to receive the resume or follow-up details on WhatsApp at the number associated with this call; a generic request to explain something is not WhatsApp consent. Use negativeSignals for explicit opt-out, lack of interest, complaints about repeated calls, or hostility/abuse. A phrase such as "call mat kijiye", "stop calling", or its Telugu equivalent is do_not_contact even when politely phrased. Return at most three concise items in each list.
For blockers, use the canonical tags budget_barrier, timing_barrier, other_decision_maker, or just_looking when one applies. just_looking means the lead is curious or browsing but expresses no concrete need or buying plan. timing_barrier means a concrete need exists but the timing is not right. Do not confuse these two cases.
Set customerType to BUSINESS only when the lead owns, runs, or represents a business; set it to INDIVIDUAL when they explicitly do not have a business or want a personal/professional website; otherwise omit it. Capture geographic markets, operating locations, delivery areas, or target locations in locations.
Classify a requirement as HARD only when the lead states it as mandatory, SOFT for preferences, and UNKNOWN otherwise.
Set callbackPhrase only when the latest lead turn explicitly requests, schedules, or confirms a callback. Never infer a callback from the assistant's question or from casual phrases. Return one overall confidence for the patch. Do not return source turn IDs; the application attaches them.`;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function confidence(value: unknown, field: string): number {
  if (typeof value !== "number" || value < 0 || value > 1) {
    throw new Error(`${field} must be a number between 0 and 1`);
  }
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function evidence<T>(value: T, turnId: string, score: number): Evidence<T> {
  return { value, sourceTurnIds: [turnId], confidence: score };
}

function stringArray(
  raw: unknown,
  field: string,
): string[] {
  if (!Array.isArray(raw)) throw new Error(`${field} must be an array`);
  return raw.map((item, index) => stringValue(item, `${field}[${index}]`));
}

function parseRequirementArray(
  raw: unknown,
  turnId: string,
  score: number,
): Evidence<Requirement>[] {
  if (!Array.isArray(raw)) throw new Error("requirements must be an array");
  return raw.map((item, index) => {
    if (!isObject(item)) throw new Error(`requirements[${index}] must be an object`);
    const text = stringValue(item.text, `requirements[${index}]`);
    const importance = item.importance;
    if (importance !== "HARD" && importance !== "SOFT" && importance !== "UNKNOWN") {
      throw new Error(`requirements[${index}].importance is invalid`);
    }
    return evidence(
      { text, importance: importance as RequirementImportance },
      turnId,
      score,
    );
  });
}

function parseLanguage(value: unknown): SupportedLanguage | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "EN" || value === "HI" || value === "TE" || value === "MIXED" || value === "UNKNOWN") {
    return value;
  }
  throw new Error("language is invalid");
}

export class ModelLeadUnderstandingAdapter implements LeadUnderstandingPort {
  private readonly client: StructuredLeadPatchClient;

  constructor(client: StructuredLeadPatchClient) {
    this.client = client;
  }

  async understand(input: LeadUnderstandingInput): Promise<ExtractedLeadUpdate> {
    const raw = await this.client.generate({
      turnId: input.turn.turnId,
      instruction: INSTRUCTION,
      turnText: input.turn.text,
      ...(input.turn.precedingAssistantText === undefined
        ? {}
        : { precedingAssistantText: input.turn.precedingAssistantText }),
      ...(input.turn.languageHint ? { languageHint: input.turn.languageHint } : {}),
      schemaName: "lead_state_patch",
      schema: LEAD_PATCH_SCHEMA,
    });
    if (!isObject(raw)) throw new Error("Lead understanding output must be an object");
    const turnId = input.turn.turnId;
    const language = parseLanguage(raw.language);
    const score = confidence(raw.confidence, "confidence");

    let decisionMaker: Evidence<"SELF" | "OTHER" | "UNKNOWN"> | undefined;
    if (raw.decisionMaker != null) {
      const value = raw.decisionMaker;
      if (value !== "SELF" && value !== "OTHER" && value !== "UNKNOWN") {
        throw new Error("decisionMaker is invalid");
      }
      decisionMaker = evidence(value, turnId, score);
    }

    let customerType: Evidence<"BUSINESS" | "INDIVIDUAL" | "UNKNOWN"> | undefined;
    if (raw.customerType != null) {
      const value = raw.customerType;
      if (value !== "BUSINESS" && value !== "INDIVIDUAL" && value !== "UNKNOWN") {
        throw new Error("customerType is invalid");
      }
      customerType = evidence(value, turnId, score);
    }

    const strings = (value: unknown, field: string): Evidence<string>[] =>
      stringArray(value ?? [], field).map((item) => evidence(item, turnId, score));
    const negatives = stringArray(raw.negativeSignals ?? [], "negativeSignals").map(
      (item) => {
        if (
          item !== "do_not_contact" &&
          item !== "not_interested" &&
          item !== "repeated_call_complaint" &&
          item !== "hostile_or_abusive"
        ) throw new Error("negativeSignals contains an invalid value");
        return evidence(item as NegativeLeadSignal, turnId, score);
      },
    );
    const numeric = (value: unknown, field: string): Evidence<number> | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${field} must be a non-negative number`);
      }
      return evidence(value, turnId, score);
    };
    const productCount = numeric(raw.productCount, "productCount");
    const budgetInr = numeric(raw.budgetInr, "budgetInr");

    return {
      ...(language ? { language } : {}),
      ...(raw.businessDescription != null
        ? { businessDescription: evidence(
            stringValue(raw.businessDescription, "businessDescription"),
            turnId,
            score,
          ) }
        : {}),
      ...(customerType ? { customerType } : {}),
      locations: strings(raw.locations, "locations"),
      products: strings(raw.products, "products"),
      ...(productCount === undefined ? {} : { productCount }),
      ...(budgetInr === undefined ? {} : { budgetInr }),
      ...(raw.timeline != null
        ? { timeline: evidence(
            stringValue(raw.timeline, "timeline"),
            turnId,
            score,
          ) }
        : {}),
      requirements: parseRequirementArray(raw.requirements ?? [], turnId, score),
      ...(decisionMaker ? { decisionMaker } : {}),
      blockers: strings(raw.blockers, "blockers"),
      buyingSignals: strings(raw.buyingSignals, "buyingSignals"),
      negativeSignals: negatives,
      ...(raw.callbackPhrase != null
        ? { callbackPhrase: evidence(
            stringValue(raw.callbackPhrase, "callbackPhrase"),
            turnId,
            score,
          ) }
        : {}),
    };
  }
}

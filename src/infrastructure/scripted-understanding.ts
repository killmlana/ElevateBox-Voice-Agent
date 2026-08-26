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

export interface ScriptedRequirement {
  text: string;
  importance?: RequirementImportance;
}

export interface ScriptedLeadPatch {
  language?: SupportedLanguage;
  businessDescription?: string;
  customerType?: "BUSINESS" | "INDIVIDUAL" | "UNKNOWN";
  locations?: string[];
  products?: string[];
  productCount?: number;
  budgetInr?: number;
  timeline?: string;
  requirements?: Array<string | ScriptedRequirement>;
  decisionMaker?: "SELF" | "OTHER" | "UNKNOWN";
  blockers?: string[];
  buyingSignals?: string[];
  negativeSignals?: NegativeLeadSignal[];
  callbackPhrase?: string;
  confidence?: number;
}

function evidence<T>(value: T, turnId: string, score: number): Evidence<T> {
  return { value, sourceTurnIds: [turnId], confidence: score };
}

export class ScriptedLeadUnderstandingAdapter implements LeadUnderstandingPort {
  private readonly patches: Readonly<Record<string, ScriptedLeadPatch>>;

  constructor(patches: Readonly<Record<string, ScriptedLeadPatch>>) {
    this.patches = patches;
  }

  async understand(input: LeadUnderstandingInput): Promise<ExtractedLeadUpdate> {
    const patch = this.patches[input.turn.turnId];
    if (!patch) throw new Error(`No scripted lead patch for turn ${input.turn.turnId}`);
    const turnId = input.turn.turnId;
    const score = patch.confidence ?? 0.9;
    const requirements = (patch.requirements ?? []).map((item) => {
      const value: Requirement = typeof item === "string"
        ? { text: item, importance: "UNKNOWN" }
        : { text: item.text, importance: item.importance ?? "UNKNOWN" };
      return evidence(value, turnId, score);
    });

    return {
      ...(patch.language ? { language: patch.language } : {}),
      ...(patch.businessDescription
        ? { businessDescription: evidence(patch.businessDescription, turnId, score) }
        : {}),
      ...(patch.customerType
        ? { customerType: evidence(patch.customerType, turnId, score) }
        : {}),
      locations: (patch.locations ?? []).map((value) => evidence(value, turnId, score)),
      products: (patch.products ?? []).map((value) => evidence(value, turnId, score)),
      ...(patch.productCount !== undefined
        ? { productCount: evidence(patch.productCount, turnId, score) }
        : {}),
      ...(patch.budgetInr !== undefined
        ? { budgetInr: evidence(patch.budgetInr, turnId, score) }
        : {}),
      ...(patch.timeline ? { timeline: evidence(patch.timeline, turnId, score) } : {}),
      requirements,
      ...(patch.decisionMaker
        ? { decisionMaker: evidence(patch.decisionMaker, turnId, score) }
        : {}),
      blockers: (patch.blockers ?? []).map((value) => evidence(value, turnId, score)),
      buyingSignals: (patch.buyingSignals ?? []).map((value) =>
        evidence(value, turnId, score)
      ),
      negativeSignals: (patch.negativeSignals ?? []).map((value) =>
        evidence(value, turnId, score)
      ),
      ...(patch.callbackPhrase
        ? { callbackPhrase: evidence(patch.callbackPhrase, turnId, score) }
        : {}),
    };
  }
}

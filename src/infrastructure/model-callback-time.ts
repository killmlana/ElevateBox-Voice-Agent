import type {
  CallbackResolution,
  CallbackTimeRequest,
  CallbackTimeResolverPort,
  SupportedLanguage,
} from "../contracts.ts";
import { resolveCallbackTime } from "../domain/callback-time.ts";
import type { StructuredLeadPatchClient } from "./model-lead-understanding.ts";

const IST_OFFSET_MINUTES = 330;
const IST_TIME_ZONE = "Asia/Kolkata";

/**
 * A callback more than this far out is treated as a hallucination rather than a
 * booking. Leads schedule in days, not years, and an unchecked timestamp would
 * silently park a real callback beyond any useful horizon.
 */
const MAX_HORIZON_DAYS = 60;

/**
 * Tolerance for a resolved time that lands marginally in the past - clock skew
 * and the seconds spent in the model call should not reject an otherwise good
 * answer, but a genuinely past booking must be discarded.
 */
const PAST_TOLERANCE_MS = 5 * 60_000;

export interface CallbackTimeClient {
  generate(input: {
    instruction: string;
    rawTime: string;
    nowIso: string;
    nowLocal: string;
    timeZone: string;
    languageHint?: SupportedLanguage;
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<unknown>;
}

export const CALLBACK_TIME_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["status", "resolvedAt", "reason"],
  properties: {
    status: { enum: ["resolved", "needs_clarification", "not_requested"] },
    resolvedAt: {
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    },
    reason: {
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    },
  },
};

export const CALLBACK_TIME_INSTRUCTION =
  `Convert a lead's spoken callback request into one exact instant.
The lead may speak English, Hindi, Telugu, or a mix, and may use relative words
("kal", "tomorrow", "day after", "Monday", "after lunch", "raat ko").
Resolve every relative phrase against the supplied current local time and time zone.
Return resolvedAt as an ISO 8601 UTC timestamp ending in Z.
Return status "resolved" only when both the day and the time of day are certain.
When the day is known but the time is not, or the phrase is too vague to place on
a calendar, return status "needs_clarification" with a short reason and a null resolvedAt.
Return status "not_requested" when the text does not ask for a callback at all.
Never invent a time the lead did not indicate, and never resolve to a moment in the past.`;

function localWallClock(now: Date): string {
  const local = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const weekday = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ][local.getUTCDay()];
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${
    pad(local.getUTCDate())
  } ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())} (${weekday})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accepts the model's timestamp only when it is a real instant inside a
 * plausible booking window. Anything else is treated as no answer at all.
 */
function usableTimestamp(raw: unknown, now: Date): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const parsed = new Date(raw);
  const time = parsed.getTime();
  if (Number.isNaN(time)) return undefined;
  if (time < now.getTime() - PAST_TOLERANCE_MS) return undefined;
  if (time > now.getTime() + MAX_HORIZON_DAYS * 24 * 60 * 60_000) return undefined;
  return parsed.toISOString();
}

/**
 * Resolves callback phrases with a language model, falling back to the
 * deterministic parser.
 *
 * The deterministic parser only understands "today"/"tomorrow" plus an explicit
 * hour or period, so anything else - a weekday, "day after tomorrow", a bare
 * "after lunch" - came back as needs_clarification and no callback was ever
 * booked. The model handles the open-ended cases; the parser remains the floor
 * so an upstream failure can never lose a callback the old path would have got.
 */
export class ModelCallbackTimeResolver implements CallbackTimeResolverPort {
  private readonly client: CallbackTimeClient;

  constructor(client: CallbackTimeClient) {
    this.client = client;
  }

  async resolve(request: CallbackTimeRequest): Promise<CallbackResolution> {
    const rawTime = request.rawTime.trim();
    if (!rawTime) return { status: "not_requested" };

    const deterministic = resolveCallbackTime(rawTime, request.now);
    let raw: unknown;
    try {
      raw = await this.client.generate({
        instruction: CALLBACK_TIME_INSTRUCTION,
        rawTime,
        nowIso: request.now.toISOString(),
        nowLocal: localWallClock(request.now),
        timeZone: IST_TIME_ZONE,
        ...(request.languageHint === undefined
          ? {}
          : { languageHint: request.languageHint }),
        schemaName: "callback_time",
        schema: CALLBACK_TIME_SCHEMA,
      });
    } catch {
      return deterministic;
    }

    if (!isRecord(raw)) return deterministic;
    const status = raw.status;

    if (status === "resolved") {
      const resolvedAt = usableTimestamp(raw.resolvedAt, request.now);
      // A "resolved" verdict with an unusable timestamp tells us nothing, so
      // defer to whatever the deterministic parser managed.
      if (!resolvedAt) return deterministic;
      return { status: "resolved", rawTime, resolvedAt };
    }

    if (status === "needs_clarification") {
      // Never downgrade a deterministic success to a model's uncertainty.
      if (deterministic.status === "resolved") return deterministic;
      const reason = typeof raw.reason === "string" && raw.reason.trim() !== ""
        ? raw.reason
        : "The callback time could not be placed on a calendar.";
      return {
        status: "needs_clarification",
        rawTime,
        ...(deterministic.proposedAt ? { proposedAt: deterministic.proposedAt } : {}),
        reason,
      };
    }

    if (status === "not_requested") {
      if (deterministic.status !== "not_requested") return deterministic;
      return { status: "not_requested" };
    }

    return deterministic;
  }
}

/** Wraps the deterministic parser so callers can depend on the async port. */
export class DeterministicCallbackTimeResolver implements CallbackTimeResolverPort {
  async resolve(request: CallbackTimeRequest): Promise<CallbackResolution> {
    return resolveCallbackTime(request.rawTime, request.now);
  }
}

/**
 * Bridges callback resolution onto the structured-output client already used for
 * lead extraction, reusing its concurrency limiting, timeout and metrics rather
 * than standing up a second HTTP path. The temporal context travels as JSON in
 * the turn slot, which is what the instruction tells the model to expect.
 */
export class LeadPatchCallbackTimeClient implements CallbackTimeClient {
  private readonly client: StructuredLeadPatchClient;
  private sequence = 0;

  constructor(client: StructuredLeadPatchClient) {
    this.client = client;
  }

  async generate(
    input: Parameters<CallbackTimeClient["generate"]>[0],
  ): Promise<unknown> {
    this.sequence += 1;
    return this.client.generate({
      turnId: `callback-time-${this.sequence}`,
      instruction: input.instruction,
      turnText: JSON.stringify({
        callbackPhrase: input.rawTime,
        nowIso: input.nowIso,
        nowLocal: input.nowLocal,
        timeZone: input.timeZone,
      }),
      ...(input.languageHint === undefined
        ? {}
        : { languageHint: input.languageHint }),
      schemaName: input.schemaName,
      schema: input.schema,
    });
  }
}

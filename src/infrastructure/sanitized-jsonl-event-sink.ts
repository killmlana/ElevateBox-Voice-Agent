import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { NormalizedEvent } from "../contracts.ts";
import type { NormalizedEventSink } from "./event-store.ts";
import {
  NoopSanitizedLogger,
  safeReference,
  type SanitizedLogger,
} from "./sanitized-logger.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)
    ? value
    : undefined;
}

function contentSummary(value: unknown): { ref: string; chars: number } | undefined {
  if (typeof value !== "string") return undefined;
  return { ref: safeReference(value), chars: value.length };
}

function evidenceTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const token = safeToken(record(item)?.value);
    return token === undefined ? [] : [token];
  });
}

function numericFields(
  source: Record<string, unknown>,
  names: readonly string[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const name of names) {
    const value = finiteNumber(source[name]);
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function leadStateSummary(value: unknown): Record<string, unknown> {
  const state = record(value) ?? {};
  const callback = record(state.callback) ?? {};
  const actions = record(state.actions) ?? {};
  return {
    ...(safeToken(state.callState) ? { callState: safeToken(state.callState) } : {}),
    ...(safeToken(state.language) ? { language: safeToken(state.language) } : {}),
    languageLocked: state.languageLocked === true,
    ...(safeToken(state.intent) ? { intent: safeToken(state.intent) } : {}),
    ...numericFields(state, ["intentScore", "intentConfidence"]),
    buyingSignals: evidenceTokens(state.buyingSignals),
    negativeSignals: evidenceTokens(state.negativeSignals),
    blockers: evidenceTokens(state.blockers),
    evidenceCounts: {
      locations: Array.isArray(state.locations) ? state.locations.length : 0,
      products: Array.isArray(state.products) ? state.products.length : 0,
      requirements: Array.isArray(state.requirements) ? state.requirements.length : 0,
    },
    callback: {
      requested: callback.requested === true,
      awaitingConfirmation: callback.awaitingConfirmation === true,
      declinedWithoutAlternative: callback.declinedWithoutAlternative === true,
      needsClarification: callback.needsClarification === true,
      booked: callback.booked === true,
      hasResolvedAt: typeof callback.resolvedAt === "string",
      hasProposedAt: typeof callback.proposedAt === "string",
    },
    actions: {
      hotWhatsappSent: actions.hotWhatsappSent === true,
      coldBrochureSent: actions.coldBrochureSent === true,
      callbackBooked: actions.callbackBooked === true,
      finalFollowupSent: actions.finalFollowupSent === true,
    },
  };
}

function classificationSummary(payload: Record<string, unknown>): Record<string, unknown> {
  const breakdown = Array.isArray(payload.scoreBreakdown)
    ? payload.scoreBreakdown.flatMap((item) => {
        const entry = record(item);
        const factor = safeToken(entry?.factor);
        const delta = finiteNumber(entry?.delta);
        return factor === undefined || delta === undefined ? [] : [{ factor, delta }];
      })
    : [];
  return {
    ...(safeToken(payload.intent) ? { intent: safeToken(payload.intent) } : {}),
    ...numericFields(payload, ["score", "confidence"]),
    scoreBreakdown: breakdown,
    evidenceCount: Array.isArray(payload.evidenceTurnIds)
      ? payload.evidenceTurnIds.length
      : 0,
  };
}

function latencySummary(payload: Record<string, unknown>): Record<string, unknown> {
  const measurements = Array.isArray(payload.measurements)
    ? payload.measurements.flatMap((item) => {
        const measurement = record(item);
        const name = safeToken(measurement?.name);
        const valueMs = finiteNumber(measurement?.valueMs);
        return name === undefined || valueMs === undefined
          ? []
          : [{ name, valueMs, measuredAt: measurement?.measuredAt }];
      })
    : [];
  const rawSummary = record(payload.summary) ?? {};
  const summary: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rawSummary)) {
    const safeName = safeToken(name);
    const item = record(value);
    if (!safeName || !item) continue;
    summary[safeName] = numericFields(item, ["count", "minMs", "p50Ms", "p95Ms", "maxMs"]);
  }
  return { measurements, summary };
}

function sanitizePayload(type: string, value: unknown): Record<string, unknown> {
  const payload = record(value) ?? {};
  if (type === "turn.completed") {
    return {
      ...(contentSummary(payload.text) ? { text: contentSummary(payload.text) } : {}),
      ...(safeToken(payload.languageHint)
        ? { languageHint: safeToken(payload.languageHint) }
        : {}),
      hasPrecedingAssistantText: typeof payload.precedingAssistantText === "string",
    };
  }
  if (type === "lead.state.updated") return leadStateSummary(payload.state);
  if (type === "language.selection_locked") {
    return {
      ...(safeToken(payload.language)
        ? { language: safeToken(payload.language) }
        : {}),
    };
  }
  if (type === "lead.classification.evaluated" || type === "lead.classification.changed") {
    return classificationSummary(payload);
  }
  if (type.startsWith("lead.analysis.")) {
    return {
      ...(typeof payload.turnId === "string"
        ? { turnRef: safeReference(payload.turnId) }
        : {}),
      ...numericFields(payload, [
        "durationMs",
        "analysisDurationMs",
        "orderedApplyWaitMs",
        "totalDurationMs",
      ]),
      ...(typeof payload.error === "string"
        ? { errorRef: safeReference(payload.error) }
        : {}),
    };
  }
  if (type === "action.requested" || type.startsWith("action.")) {
    return {
      ...(safeToken(payload.kind) ? { kind: safeToken(payload.kind) } : {}),
      ...(typeof payload.commandId === "string"
        ? { commandRef: safeReference(payload.commandId) }
        : {}),
      ...numericFields(payload, ["attempt"]),
      ...(payload.simulated === undefined ? {} : { simulated: payload.simulated === true }),
      ...(typeof payload.externalId === "string"
        ? { externalRef: safeReference(payload.externalId) }
        : {}),
      ...(typeof payload.error === "string"
        ? { errorRef: safeReference(payload.error) }
        : {}),
    };
  }
  if (type === "conversation.directive") {
    return {
      ...(safeToken(payload.intent) ? { intent: safeToken(payload.intent) } : {}),
      ...(safeToken(payload.delivery) ? { delivery: safeToken(payload.delivery) } : {}),
      ...numericFields(payload, ["priority"]),
      ...(typeof payload.directiveId === "string"
        ? { directiveRef: safeReference(payload.directiveId) }
        : {}),
    };
  }
  if (type.startsWith("callback.")) {
    return {
      ...(safeToken(payload.status) ? { status: safeToken(payload.status) } : {}),
      hasResolvedAt: typeof payload.resolvedAt === "string",
    };
  }
  if (type === "call.latency_summary") return latencySummary(payload);
  if (type.startsWith("call.")) {
    return {
      ...(safeToken(payload.state) ? { state: safeToken(payload.state) } : {}),
    };
  }
  if (type === "turn.duplicate_ignored") {
    return {
      ...(typeof payload.turnId === "string"
        ? { turnRef: safeReference(payload.turnId) }
        : {}),
    };
  }
  const serialized = JSON.stringify(payload);
  return {
    payloadRef: safeReference(serialized),
    fieldCount: Object.keys(payload).length,
    bytes: Buffer.byteLength(serialized),
  };
}

export class SanitizedJsonlEventSink {
  private readonly directory: string;
  private readonly logger: SanitizedLogger;
  private readonly writeTails = new Map<string, Promise<void>>();
  private disabled = false;

  constructor(directory: string, logger: SanitizedLogger = new NoopSanitizedLogger()) {
    this.directory = resolve(directory);
    this.logger = logger;
  }

  readonly record: NormalizedEventSink = async (event: NormalizedEvent<unknown>) => {
    if (this.disabled) return;
    const callRef = safeReference(event.callId);
    const date = /^\d{4}-\d{2}-\d{2}/.exec(event.occurredAt)?.[0] ?? "unknown-date";
    const path = join(this.directory, `${date}-${callRef}.jsonl`);
    const line = `${JSON.stringify({
      traceVersion: 1,
      callRef,
      eventRef: safeReference(event.eventId),
      seq: event.seq,
      type: event.type,
      occurredAt: event.occurredAt,
      sourceTurnRefs: event.sourceTurnIds.map(safeReference),
      payload: sanitizePayload(event.type, event.payload),
    })}\n`;
    const previous = this.writeTails.get(path) ?? Promise.resolve();
    const write = previous.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o750 });
      await appendFile(path, line, { encoding: "utf8", mode: 0o640, flag: "a" });
    });
    this.writeTails.set(path, write);
    try {
      await write;
    } catch (error) {
      this.disabled = true;
      this.logger.error("call_trace.write_failed", {
        callRef,
        errorRef: safeReference(error instanceof Error ? error.message : String(error)),
      });
    } finally {
      if (this.writeTails.get(path) === write) this.writeTails.delete(path);
    }
  };
}

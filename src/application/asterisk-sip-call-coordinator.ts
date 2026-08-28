import { createHash, randomUUID } from "node:crypto";

import type {
  ConversationControlSessionPort,
  OutboundDialAdapter,
  OutboundDialRequest,
  OutboundDialResult,
  ReadyPreparedCall,
  SessionContext,
  SipCallLifecycleState,
  TelephonyLifecycleObserver,
} from "../contracts.ts";
import type {
  AsteriskControlPort,
  AsteriskOriginatedLeg,
} from "../infrastructure/asterisk-ari-adapter.ts";
import {
  OpenAISipSidebandClosedError,
  type OpenAISipControlPort,
} from "../infrastructure/openai-sip-sideband-adapter.ts";
import type {
  OpenAIIncomingSipWebhook,
  OpenAIIncomingSipWebhookHandler,
} from "../infrastructure/openai-webhook-receiver.ts";
import {
  NoopSanitizedLogger,
  safeReference,
  type SanitizedLogger,
} from "../infrastructure/sanitized-logger.ts";
import type { PrototypeCallSession, PrototypeSystem } from "./prototype-system.ts";
import { LiveCallController } from "./live-call-controller.ts";
import { LiveCallLatencyRecorder } from "./live-call-latency.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve(value) {
      if (result.settled) return;
      result.settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (result.settled) return;
      result.settled = true;
      rejectPromise(error);
    },
    settled: false,
  };
  return result;
}

interface ActiveSipCall {
  context: SessionContext;
  token: string;
  expiresAtMs: number;
  state: SipCallLifecycleState;
  startedAt: number;
  ready: Deferred<ReadyPreparedCall>;
  expiryTimer: NodeJS.Timeout;
  aiLeg?: AsteriskOriginatedLeg;
  leadLeg?: AsteriskOriginatedLeg;
  sipCallId?: string;
  openAICallId?: string;
  acceptance?: Promise<void>;
  earlyIncoming: Array<{
    event: OpenAIIncomingSipWebhook;
    completion: Deferred<void>;
  }>;
  conversation?: ConversationControlSessionPort;
  workflow?: PrototypeCallSession;
  controller?: LiveCallController;
  latency?: LiveCallLatencyRecorder;
  eventForwarder?: Promise<void>;
  bridgeId?: string;
  terminating?: Promise<void>;
}

interface RememberedDial {
  fingerprint: string;
  result: Promise<OutboundDialResult>;
}

export interface AsteriskSipCallCoordinatorOptions {
  projectId: string;
  callerId?: string;
  ttlMs?: number;
  tokenFactory?: () => string;
  monotonicNow?: () => number;
  wallNow?: () => Date;
  openingInstruction?: string;
  callbackOpeningInstructions?: Partial<Record<"EN" | "HI" | "TE", string>>;
  logger?: SanitizedLogger;
  maxIdempotencyEntries?: number;
}

function sipHeader(
  event: OpenAIIncomingSipWebhook,
  name: string,
): string | undefined {
  return event.sipHeaders.find(
    (header) => header.name.toLowerCase() === name.toLowerCase(),
  )?.value.trim();
}

function fingerprint(request: OutboundDialRequest): string {
  return createHash("sha256").update(JSON.stringify({
    callId: request.media.callId,
    token: request.media.token,
    provider: request.media.provider,
    to: request.to,
  })).digest("hex");
}

/** Single-call SIP state machine shared by prepare, webhook, dial, and ARI. */
export class AsteriskSipCallCoordinator
  implements
    OutboundDialAdapter,
    OpenAIIncomingSipWebhookHandler,
    TelephonyLifecycleObserver {
  private readonly asterisk: AsteriskControlPort;
  private readonly openAI: OpenAISipControlPort;
  private readonly workflows: PrototypeSystem;
  private readonly projectId: string;
  private readonly callerId: string | undefined;
  private readonly ttlMs: number;
  private readonly tokenFactory: () => string;
  private readonly monotonicNow: () => number;
  private readonly wallNow: () => Date;
  private readonly openingInstruction: string | undefined;
  private readonly callbackOpeningInstructions: Partial<Record<"EN" | "HI" | "TE", string>>;
  private readonly logger: SanitizedLogger;
  private readonly maximumIdempotencyEntries: number;
  private readonly states = new Map<string, SipCallLifecycleState>();
  private readonly dials = new Map<string, RememberedDial>();
  private readonly unsubscribe: () => void;
  private active: ActiveSipCall | undefined;
  private closed = false;

  constructor(
    asterisk: AsteriskControlPort,
    openAI: OpenAISipControlPort,
    workflows: PrototypeSystem,
    options: AsteriskSipCallCoordinatorOptions,
  ) {
    if (!options.projectId.trim()) throw new Error("OpenAI project ID is required");
    this.asterisk = asterisk;
    this.openAI = openAI;
    this.workflows = workflows;
    this.projectId = options.projectId;
    this.callerId = options.callerId?.trim() || undefined;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => new Date());
    this.openingInstruction = options.openingInstruction;
    this.callbackOpeningInstructions = options.callbackOpeningInstructions ?? {};
    this.logger = options.logger ?? new NoopSanitizedLogger();
    this.maximumIdempotencyEntries = options.maxIdempotencyEntries ?? 10_000;
    this.unsubscribe = this.asterisk.subscribe(this);
  }

  async start(): Promise<void> {
    await this.asterisk.start();
    await this.asterisk.cleanupOrphans();
  }

  async prepare(context: SessionContext): Promise<ReadyPreparedCall> {
    if (this.closed) throw new Error("SIP call coordinator is closed");
    if (this.active && !["ENDED", "FAILED"].includes(this.active.state)) {
      throw new Error("Only one preparing or active SIP call is supported");
    }
    const token = this.tokenFactory();
    const expiresAtMs = this.wallNow().getTime() + this.ttlMs;
    const ready = deferred<ReadyPreparedCall>();
    const active: ActiveSipCall = {
      context,
      token,
      expiresAtMs,
      state: "PREPARING_AI" as const,
      startedAt: this.monotonicNow(),
      ready,
      earlyIncoming: [],
      expiryTimer: undefined as unknown as NodeJS.Timeout,
    };
    active.expiryTimer = setTimeout(() => {
      const error = new Error("Prepared SIP call expired before reaching READY");
      active.ready.reject(error);
      void this.terminate(active, "FAILED", error);
    }, this.ttlMs);
    active.expiryTimer.unref();
    this.active = active;
    this.setState(active, "PREPARING_AI");

    try {
      const aiLeg = await this.asterisk.originateOpenAI(
        context.callId,
        this.projectId,
      );
      active.aiLeg = aiLeg;
      void aiLeg.answered.catch(() => undefined);
      const sipCallId = aiLeg.sipCallId;
      if (!sipCallId) {
        throw new Error("Asterisk OpenAI leg did not expose a SIP Call-ID");
      }
      active.sipCallId = sipCallId;
      this.flushEarlyIncoming(active);
      return await active.ready.promise;
    } catch (error) {
      active.ready.reject(error);
      await this.terminate(active, "FAILED", error);
      throw error;
    }
  }

  async handleIncomingCall(event: OpenAIIncomingSipWebhook): Promise<void> {
    const active = this.active;
    if (
      active &&
      active.state === "PREPARING_AI" &&
      !active.sipCallId
    ) {
      if (active.earlyIncoming.length >= 8) {
        await this.openAI.reject(event.callId, 486);
        return;
      }
      const completion = deferred<void>();
      active.earlyIncoming.push({ event, completion });
      return completion.promise;
    }
    await this.processIncomingCall(event);
  }

  private async processIncomingCall(event: OpenAIIncomingSipWebhook): Promise<void> {
    const sipCallId = sipHeader(event, "Call-ID");
    const active = this.active;
    if (
      !sipCallId ||
      !active ||
      active.sipCallId !== sipCallId ||
      active.state !== "PREPARING_AI" ||
      active.expiresAtMs <= this.wallNow().getTime()
    ) {
      await Promise.allSettled([
        this.openAI.reject(event.callId, 603),
        ...(sipCallId ? [this.asterisk.hangupBySipCallId(sipCallId)] : []),
      ]);
      if (active && active.sipCallId === sipCallId) {
        await this.terminate(
          active,
          "FAILED",
          new Error("Incoming OpenAI SIP call was expired or not pending"),
        );
      }
      this.logger.warn("openai_sip.unmatched_call_rejected", {
        openAICallRef: safeReference(event.callId),
        ...(sipCallId ? { sipCallRef: safeReference(sipCallId) } : {}),
      });
      return;
    }

    if (active.openAICallId && active.openAICallId !== event.callId) {
      await this.openAI.reject(event.callId, 486);
      return;
    }
    active.openAICallId = event.callId;
    active.acceptance ??= this.establishAI(active);
    await active.acceptance;
  }

  private flushEarlyIncoming(active: ActiveSipCall): void {
    for (const pending of active.earlyIncoming.splice(0)) {
      void this.processIncomingCall(pending.event).then(
        () => pending.completion.resolve(undefined),
        (error) => pending.completion.reject(error),
      );
    }
  }

  dial(request: OutboundDialRequest): Promise<OutboundDialResult> {
    if (!request.idempotencyKey.trim() || request.idempotencyKey.length > 128) {
      return Promise.reject(new Error("Outbound dial idempotencyKey is invalid"));
    }
    const requestFingerprint = fingerprint(request);
    const remembered = this.dials.get(request.idempotencyKey);
    if (remembered) {
      if (remembered.fingerprint !== requestFingerprint) {
        return Promise.reject(
          new Error("Outbound dial idempotency key was reused for another call"),
        );
      }
      return remembered.result;
    }
    if (this.dials.size >= this.maximumIdempotencyEntries) {
      return Promise.reject(new Error("SIP dial idempotency capacity is exhausted"));
    }
    const result = this.performDial(request);
    this.dials.set(request.idempotencyKey, {
      fingerprint: requestFingerprint,
      result,
    });
    return result;
  }

  async abort(token: string): Promise<void> {
    const active = this.active;
    if (!active || active.token !== token) return;
    active.ready.reject(new Error("Prepared SIP call was aborted"));
    await this.terminate(active, "FAILED");
  }

  onEvent(type: string, payload: Record<string, unknown>): void {
    const active = this.active;
    if (!active) return;
    const channelId = typeof payload.channelId === "string"
      ? payload.channelId
      : undefined;
    if (type === "telephony.dtmf" && active.controller) {
      active.controller.onEvent(type, payload);
      return;
    }
    if (
      (type === "telephony.stopped" || type === "telephony.channel_destroyed") &&
      channelId &&
      [active.aiLeg?.channelId, active.leadLeg?.channelId].includes(channelId) &&
      (active.state === "BRIDGED" || active.state === "DIALING_LEAD")
    ) {
      active.controller?.onEvent("telephony.stopped", payload);
      void this.terminate(active, "ENDED");
    }
  }

  stateFor(callId: string): SipCallLifecycleState | undefined {
    return this.states.get(callId);
  }

  activeCount(): number {
    const state = this.active?.state;
    return state && !["ENDED", "FAILED"].includes(state) ? 1 : 0;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    if (this.active) await this.terminate(this.active, "ENDED");
    await this.asterisk.close();
  }

  private async establishAI(active: ActiveSipCall): Promise<void> {
    try {
      const [conversation] = await Promise.all([
        this.openAI.accept(active.openAICallId!, active.context),
        active.aiLeg!.answered,
      ]);
      active.conversation = conversation;
      const workflow = await this.workflows.startCall(active.context.callId);
      active.workflow = workflow;
      const latency = new LiveCallLatencyRecorder(this.monotonicNow, this.wallNow);
      latency.recordSipReadiness(this.monotonicNow() - active.startedAt);
      active.latency = latency;
      const controller = new LiveCallController(
        conversation,
        workflow,
        latency,
        this.wallNow,
        this.openingFor(active.context),
      );
      active.controller = controller;
      active.eventForwarder = this.forwardEvents(active, conversation, controller);
      this.setState(active, "AI_READY");
      active.ready.resolve({
        ready: true,
        callId: active.context.callId,
        token: active.token,
        expiresAt: new Date(active.expiresAtMs).toISOString(),
        provider: "asterisk-sip",
      });
    } catch (error) {
      active.ready.reject(error);
      await this.terminate(active, "FAILED", error);
      throw error;
    }
  }

  private openingFor(context: SessionContext): string | undefined {
    if (context.leadContext?.scheduledCallback !== true) return this.openingInstruction;
    const language = context.preferredLanguage;
    if (language === "EN" || language === "HI" || language === "TE") {
      return this.callbackOpeningInstructions[language] ?? this.openingInstruction;
    }
    return this.callbackOpeningInstructions.HI ?? this.openingInstruction;
  }

  private async performDial(
    request: OutboundDialRequest,
  ): Promise<OutboundDialResult> {
    const active = this.active;
    if (
      request.media.provider !== "asterisk-sip" ||
      !active ||
      active.state !== "AI_READY" ||
      active.token !== request.media.token ||
      active.context.callId !== request.media.callId ||
      active.expiresAtMs <= this.wallNow().getTime()
    ) {
      throw new Error("Zadarma dialing requires the exact unexpired AI_READY token");
    }
    clearTimeout(active.expiryTimer);
    this.setState(active, "DIALING_LEAD");
    let silencingAI = false;
    try {
      await this.asterisk.startSilence(active.aiLeg!.channelId);
      silencingAI = true;
      const leadLeg = await this.asterisk.originateLead(
        active.context.callId,
        request.to,
        this.callerId,
      );
      active.leadLeg = leadLeg;
      await leadLeg.answered;
      await this.asterisk.stopSilence(active.aiLeg!.channelId);
      silencingAI = false;
      active.controller!.onEvent("telephony.answered", {
        channelId: leadLeg.channelId,
        provider: "zadarma",
      });
      const bridgeId = await this.asterisk.createBridge(active.context.callId);
      active.bridgeId = bridgeId;
      await this.asterisk.addChannels(bridgeId, [
        active.aiLeg!.channelId,
        leadLeg.channelId,
      ]);
      this.setState(active, "BRIDGED");
      active.controller!.onEvent("telephony.started", {
        bridgeId,
        aiChannelId: active.aiLeg!.channelId,
        leadChannelId: leadLeg.channelId,
        provider: "asterisk-sip",
      });
      void this.inspectFormats(active);
      return {
        providerCallId: leadLeg.channelId,
        status: "bridged",
        simulated: false,
      };
    } catch (error) {
      if (silencingAI) {
        await this.asterisk.stopSilence(active.aiLeg!.channelId).catch(() => undefined);
      }
      await this.terminate(active, "FAILED", error);
      throw error;
    }
  }

  private async forwardEvents(
    active: ActiveSipCall,
    conversation: ConversationControlSessionPort,
    controller: LiveCallController,
  ): Promise<void> {
    try {
      for await (const event of conversation.events()) {
        controller.onEvent(event.type, event.payload);
      }
      if (!["ENDED", "FAILED"].includes(active.state)) {
        const error = new Error(
          "OpenAI SIP sideband event stream ended while the call was active",
        );
        this.logger.warn("openai_sip.sideband_event_stream_ended", {
          callRef: safeReference(active.context.callId),
          state: active.state,
        });
        this.logger.warn("sip_call.control_stream_closed", {
          callRef: safeReference(active.context.callId),
          state: active.state,
        });
        await this.terminate(active, "FAILED", error);
      }
    } catch (error) {
      if (!["ENDED", "FAILED"].includes(active.state)) {
        if (error instanceof OpenAISipSidebandClosedError) {
          this.logger.warn("openai_sip.sideband_closed", {
            callRef: safeReference(active.context.callId),
            state: active.state,
            closeCode: error.closeCode,
            cleanCloseCode: error.closeCode === 1000,
            reasonRef: error.reasonRef,
          });
        } else {
          this.logger.warn("openai_sip.sideband_event_stream_failed", {
            callRef: safeReference(active.context.callId),
            state: active.state,
            errorRef: safeReference(
              error instanceof Error ? error.message : String(error),
            ),
          });
        }
        await this.terminate(active, "FAILED", error);
      }
    }
  }

  private async inspectFormats(active: ActiveSipCall): Promise<void> {
    if (!active.aiLeg || !active.leadLeg) return;
    try {
      const [ai, lead] = await Promise.all([
        this.asterisk.negotiatedFormats(active.aiLeg.channelId),
        this.asterisk.negotiatedFormats(active.leadLeg.channelId),
      ]);
      const codecMatch = Boolean(
        ai.readFormat &&
        ai.writeFormat &&
        lead.readFormat &&
        lead.writeFormat &&
        ai.readFormat === lead.writeFormat &&
        ai.writeFormat === lead.readFormat,
      );
      this.logger.info("asterisk.formats.negotiated", {
        aiRead: ai.readFormat ?? "unknown",
        aiWrite: ai.writeFormat ?? "unknown",
        leadRead: lead.readFormat ?? "unknown",
        leadWrite: lead.writeFormat ?? "unknown",
        codecMatch,
      });
    } catch (error) {
      this.logger.warn("asterisk.formats.inspect_failed", {
        errorRef: safeReference(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  private setState(active: ActiveSipCall, state: SipCallLifecycleState): void {
    active.state = state;
    this.states.set(active.context.callId, state);
    this.logger.info("sip_call.state_changed", {
      callRef: safeReference(active.context.callId),
      state,
    });
  }

  private terminate(
    active: ActiveSipCall,
    state: "ENDED" | "FAILED",
    error?: unknown,
  ): Promise<void> {
    if (active.terminating) return active.terminating;
    active.terminating = (async () => {
      clearTimeout(active.expiryTimer);
      this.setState(active, state);
      for (const pending of active.earlyIncoming.splice(0)) {
        pending.completion.reject(
          error ?? new Error("SIP preparation ended before webhook correlation"),
        );
      }
      active.controller?.scheduleEnd();
      const tasks: Promise<unknown>[] = [];
      if (active.bridgeId) tasks.push(this.asterisk.destroyBridge(active.bridgeId));
      if (active.leadLeg) tasks.push(this.asterisk.hangupChannel(active.leadLeg.channelId));
      if (active.aiLeg) tasks.push(this.asterisk.hangupChannel(active.aiLeg.channelId));
      if (active.openAICallId) tasks.push(this.openAI.hangup(active.openAICallId));
      if (active.conversation) tasks.push(active.conversation.close());
      await Promise.allSettled(tasks);
      await active.controller?.idle().catch(() => undefined);
      if (active.workflow && active.latency) {
        const measurements = active.latency.measurements();
        const summary = active.latency.summary();
        await active.workflow.recordTelemetry("call.latency_summary", {
          measurements,
          summary,
        }).catch((traceError: unknown) => {
          this.logger.warn("sip_call.latency_trace_failed", {
            callRef: safeReference(active.context.callId),
            errorRef: safeReference(
              traceError instanceof Error ? traceError.message : String(traceError),
            ),
          });
        });
        this.logger.info("sip_call.latency_summary", {
          callRef: safeReference(active.context.callId),
          measurementCount: measurements.length,
          sipReadinessMs: summary.openai_sip_readiness_ms?.p50Ms ?? null,
          answerToBridgeMs: summary.pstn_answer_to_bridge_ms?.p50Ms ?? null,
          bridgeToFirstModelResponseMs:
            summary.bridge_to_first_model_response_ms?.p50Ms ?? null,
          turnResponseP50Ms:
            summary.speech_stop_to_first_model_response_ms?.p50Ms ?? null,
          turnResponseP95Ms:
            summary.speech_stop_to_first_model_response_ms?.p95Ms ?? null,
          bargeInCancelAckP95Ms:
            summary.sip_barge_in_cancel_ack_ms?.p95Ms ?? null,
        });
      }
      if (this.active === active) this.active = undefined;
      if (error) {
        this.logger.warn("sip_call.failed", {
          callRef: safeReference(active.context.callId),
          errorRef: safeReference(error instanceof Error ? error.message : String(error)),
        });
      }
    })();
    return active.terminating;
  }
}

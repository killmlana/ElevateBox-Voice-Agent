import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { LiveCallCoordinator } from "./application/live-call-controller.ts";
import { AsteriskSipCallCoordinator } from "./application/asterisk-sip-call-coordinator.ts";
import { PrototypeSystem } from "./application/prototype-system.ts";
import type { ConversationRuntime, LeadUnderstandingPort } from "./contracts.ts";
import {
  ELEVATEBOX_CALLBACK_START,
  ELEVATEBOX_OUTBOUND_PROMPT,
  ELEVATEBOX_OUTBOUND_START,
} from "./prompts/elevatebox-outbound.ts";
import { loadProductionConfig, type ProductionConfig } from "./production-config.ts";
import { SystemClock } from "./infrastructure/clock.ts";
import {
  DryRunOutboundDialAdapter,
  DryRunPreparedCallCoordinator,
} from "./infrastructure/dry-run-call-adapters.ts";
import {
  DryRunConversationRuntime,
  DryRunLeadUnderstandingAdapter,
} from "./infrastructure/dry-run-adapters.ts";
import { ExotelOutboundDialAdapter } from "./infrastructure/exotel-outbound-dial-adapter.ts";
import {
  LiveGatewayServer,
  type LiveGatewayAddress,
  type LiveGatewayCoordinator,
  type OpenAIRealtimeWebhookReceiver,
} from "./infrastructure/live-gateway-server.ts";
import { AsteriskAriAdapter } from "./infrastructure/asterisk-ari-adapter.ts";
import { MetaWhatsAppAdapter } from "./infrastructure/meta-whatsapp-adapter.ts";
import { OpenWAWhatsAppAdapter } from "./infrastructure/openwa-whatsapp-adapter.ts";
import { ModelLeadUnderstandingAdapter } from "./infrastructure/model-lead-understanding.ts";
import {
  DeterministicCallbackTimeResolver,
  LeadPatchCallbackTimeClient,
  ModelCallbackTimeResolver,
} from "./infrastructure/model-callback-time.ts";
import { NodeRealtimeSocketFactory } from "./infrastructure/node-realtime-socket.ts";
import { OpenAIRealtimeRuntime } from "./infrastructure/openai-realtime-runtime.ts";
import { OpenAISipSidebandAdapter } from "./infrastructure/openai-sip-sideband-adapter.ts";
import { VerifiedOpenAIWebhookReceiver } from "./infrastructure/openai-webhook-receiver.ts";
import { OpenAIResponsesLeadPatchClient } from "./infrastructure/openai-responses-lead-client.ts";
import { SanitizedJsonlEventSink } from "./infrastructure/sanitized-jsonl-event-sink.ts";
import {
  ConsoleSanitizedLogger,
  safeReference,
  type SanitizedLogger,
} from "./infrastructure/sanitized-logger.ts";
import { WebhookCallbackSchedulerAdapter } from "./infrastructure/webhook-callback-scheduler-adapter.ts";
import { DurableSipCallbackScheduler } from "./infrastructure/durable-sip-callback-scheduler.ts";

export interface ProductionDependencies {
  fetchFn?: typeof fetch;
  logger?: SanitizedLogger;
}

export class ProductionApplication {
  readonly gateway: LiveGatewayServer;
  private readonly logger: SanitizedLogger;
  private readonly mode: ProductionConfig["mode"];
  private readonly dialMode: ProductionConfig["exotelDialMode"];
  private readonly provider: ProductionConfig["outboundCallProvider"];
  private readonly lifecycle: { start(): Promise<void>; close(): Promise<void> } | undefined;
  private readonly whatsappMode: ProductionConfig["whatsappMode"];
  private readonly whatsappProvider: ProductionConfig["whatsappProvider"];
  private readonly callbackMode: ProductionConfig["callbackMode"];

  constructor(
    gateway: LiveGatewayServer,
    logger: SanitizedLogger,
    mode: ProductionConfig["mode"],
    dialMode: ProductionConfig["exotelDialMode"],
    provider: ProductionConfig["outboundCallProvider"],
    whatsappMode: ProductionConfig["whatsappMode"],
    whatsappProvider: ProductionConfig["whatsappProvider"],
    callbackMode: ProductionConfig["callbackMode"],
    lifecycle?: { start(): Promise<void>; close(): Promise<void> },
  ) {
    this.gateway = gateway;
    this.logger = logger;
    this.mode = mode;
    this.dialMode = dialMode;
    this.provider = provider;
    this.whatsappMode = whatsappMode;
    this.whatsappProvider = whatsappProvider;
    this.callbackMode = callbackMode;
    this.lifecycle = lifecycle;
  }

  async start(): Promise<LiveGatewayAddress> {
    await this.lifecycle?.start();
    let address: LiveGatewayAddress;
    try {
      address = await this.gateway.listen();
    } catch (error) {
      await this.lifecycle?.close().catch(() => undefined);
      throw error;
    }
    this.logger.info("gateway.started", {
      host: address.host,
      port: address.port,
      mode: this.mode,
      outboundDialMode: this.dialMode,
      outboundCallProvider: this.provider,
      pstnCarrier: this.provider === "asterisk-sip" ? "zadarma" : "exotel",
      whatsappMode: this.whatsappMode,
      whatsappProvider: this.whatsappProvider,
      callbackMode: this.callbackMode,
    });
    return address;
  }

  async close(): Promise<void> {
    await this.gateway.close();
    await this.lifecycle?.close();
    this.logger.info("gateway.stopped");
  }
}

function liveVoiceRuntime(config: ProductionConfig): ConversationRuntime {
  const apiKey = config.openai.apiKey;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required in live mode");
  return new OpenAIRealtimeRuntime(
    {
      apiKey,
      instructions: ELEVATEBOX_OUTBOUND_PROMPT,
      model: config.openai.realtimeModel,
      voice: config.openai.realtimeVoice,
      reasoningEffort: config.openai.realtimeReasoningEffort,
      ...(config.openai.realtimeMaxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: config.openai.realtimeMaxOutputTokens }),
      handshakeTimeoutMs: config.openai.realtimeHandshakeTimeoutMs,
      inputTranscriptionModel: config.openai.transcriptionModel,
      transcriptionPrompt:
        "ElevateBox, e-commerce website, catalogue, payments, COD, inventory, WhatsApp, budget, timeline, callback; Hindi, Telugu, English and code-switching.",
      semanticVadEagerness: "high",
      languages: ["EN", "HI", "TE", "MIXED"],
      ...(config.openai.safetyIdentifier === undefined
        ? {}
        : { safetyIdentifier: config.openai.safetyIdentifier }),
    },
    new NodeRealtimeSocketFactory(),
  );
}

/**
 * One structured-output client serves both lead extraction and callback-time
 * resolution, so its concurrency limit and timeout govern all sidecar model
 * traffic rather than each caller opening its own uncapped path.
 */
function liveLeadPatchClient(
  config: ProductionConfig,
  fetchFn: typeof fetch,
): OpenAIResponsesLeadPatchClient {
  const apiKey = config.openai.apiKey;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required in live mode");
  return new OpenAIResponsesLeadPatchClient(
    {
      apiKey,
      model: config.openai.leadModel,
      timeoutMs: config.openai.leadTimeoutMs,
      maxOutputTokens: config.openai.leadMaxOutputTokens,
      maxConcurrency: config.openai.leadConcurrency,
    },
    fetchFn,
  );
}

function combinedLifecycle(
  lifecycles: Array<{ start(): Promise<void>; close(): Promise<void> }>,
): { start(): Promise<void>; close(): Promise<void> } {
  return {
    async start() {
      for (const lifecycle of lifecycles) await lifecycle.start();
    },
    async close() {
      for (const lifecycle of [...lifecycles].reverse()) await lifecycle.close();
    },
  };
}

/**
 * The only application composition root. Dry-run is the default and wires no
 * network-capable voice, dial, messaging, or scheduler implementation.
 */
export function createProductionApplication(
  config: ProductionConfig,
  dependencies: ProductionDependencies = {},
): ProductionApplication {
  const logger = dependencies.logger ?? new ConsoleSanitizedLogger();
  const fetchFn = dependencies.fetchFn ?? fetch;
  const leadPatchClient = config.mode === "live"
    ? liveLeadPatchClient(config, fetchFn)
    : undefined;
  const understanding = leadPatchClient
    ? new ModelLeadUnderstandingAdapter(leadPatchClient)
    : new DryRunLeadUnderstandingAdapter();
  const callbackTimes = leadPatchClient
    ? new ModelCallbackTimeResolver(new LeadPatchCallbackTimeClient(leadPatchClient))
    : new DeterministicCallbackTimeResolver();

  const messaging = config.whatsappProvider === "openwa"
    ? new OpenWAWhatsAppAdapter(
      {
        ...config.openwa,
        dryRun: config.whatsappMode === "dry-run",
        allowRealMessages: config.allowRealWhatsappMessages,
        allowUnofficialClient: config.allowUnofficialWhatsappClient,
        allowedRecipient: config.leadPhone,
        logger,
      },
      fetchFn,
    )
    : new MetaWhatsAppAdapter(
      {
        ...config.whatsapp,
        dryRun: config.whatsappMode === "dry-run",
        allowRealMessages: config.allowRealWhatsappMessages,
        allowedRecipient: config.leadPhone,
        logger,
      },
      fetchFn,
    );
  const automaticScheduler = config.callbackMode === "live" &&
      config.callbackProvider === "automatic-sip"
    ? new DurableSipCallbackScheduler({
      statePath: config.callback.statePath,
      recoveryGraceMs: config.callback.recoveryGraceMs,
      logger,
    })
    : undefined;
  const scheduler = automaticScheduler ?? new WebhookCallbackSchedulerAdapter(
      {
        ...config.callback,
        dryRun: config.callbackMode === "dry-run",
        allowLiveBookings: config.allowLiveCallbackBookings,
        allowedLeadPhone: config.leadPhone,
        logger,
      },
      fetchFn,
    );
  const eventTrace = new SanitizedJsonlEventSink(config.traceDirectory, logger);
  const workflows = new PrototypeSystem(
    {
      leadPhone: config.leadPhone,
      candidate: {
        candidatePhone: config.candidatePhone,
        resumeUrl: config.resumePath,
      },
    },
    new SystemClock(),
    messaging,
    scheduler,
    understanding,
    eventTrace.record,
    callbackTimes,
  );
  let coordinator: LiveGatewayCoordinator;
  let outboundDialer: import("./contracts.ts").OutboundDialAdapter;
  let openAIWebhookReceiver: OpenAIRealtimeWebhookReceiver | undefined;
  let lifecycle: { start(): Promise<void>; close(): Promise<void> } | undefined;

  if (config.outboundCallProvider === "exotel") {
    const runtime = config.mode === "live"
      ? liveVoiceRuntime(config)
      : new DryRunConversationRuntime();
    coordinator = new LiveCallCoordinator(runtime, workflows, {
      ttlMs: config.preparedCallTtlMs,
      openingInstruction: ELEVATEBOX_OUTBOUND_START,
    });
    outboundDialer = new ExotelOutboundDialAdapter(
      {
        ...config.exotel,
        dryRun: config.exotelDialMode === "dry-run",
        allowPaidCalls: config.allowPaidExotelCalls,
        logger,
      },
      fetchFn,
    );
  } else if (config.sipDialMode === "dry-run") {
    coordinator = new DryRunPreparedCallCoordinator({
      provider: "asterisk-sip",
      ttlMs: config.preparedCallTtlMs,
    });
    outboundDialer = new DryRunOutboundDialAdapter("asterisk-sip");
  } else {
    const apiKey = config.openai.apiKey!;
    const projectId = config.openai.projectId!;
    const webhookSecret = config.openai.webhookSecret!;
    const asterisk = new AsteriskAriAdapter(
      {
        baseUrl: config.asterisk.ariBaseUrl,
        username: config.asterisk.ariUsername!,
        password: config.asterisk.ariPassword!,
        app: config.asterisk.ariApp,
        zadarmaEndpoint: config.asterisk.zadarmaEndpoint,
        openAIEndpoint: config.asterisk.openAIEndpoint,
        requestTimeoutMs: config.asterisk.timeoutMs,
        originateTimeoutSeconds: config.asterisk.originateTimeoutSeconds,
        logger,
      },
      { fetchFn },
    );
    const openAI = new OpenAISipSidebandAdapter(
      {
        apiKey,
        instructions: ELEVATEBOX_OUTBOUND_PROMPT,
        model: config.openai.realtimeModel,
        voice: config.openai.realtimeVoice,
        inputTranscriptionModel: config.openai.transcriptionModel,
        transcriptionPrompt:
          "ElevateBox, e-commerce website, catalogue, payments, COD, inventory, WhatsApp, budget, timeline, callback; Hindi, Telugu, English and code-switching.",
        semanticVadEagerness: "high",
        ...(config.openai.realtimeMaxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: config.openai.realtimeMaxOutputTokens }),
        reasoningEffort: config.openai.realtimeReasoningEffort,
        languages: ["EN", "HI", "TE", "MIXED"],
        ...(config.openai.safetyIdentifier === undefined
          ? {}
          : { safetyIdentifier: config.openai.safetyIdentifier }),
        handshakeTimeoutMs: config.openai.realtimeHandshakeTimeoutMs,
      },
      new NodeRealtimeSocketFactory(),
      fetchFn,
    );
    const sipCoordinator = new AsteriskSipCallCoordinator(
      asterisk,
      openAI,
      workflows,
      {
        projectId,
        ...(config.asterisk.callerId
          ? { callerId: config.asterisk.callerId }
          : {}),
        ttlMs: config.preparedCallTtlMs,
        openingInstruction: ELEVATEBOX_OUTBOUND_START,
        callbackOpeningInstructions: ELEVATEBOX_CALLBACK_START,
        logger,
      },
    );
    coordinator = sipCoordinator;
    outboundDialer = sipCoordinator;
    openAIWebhookReceiver = new VerifiedOpenAIWebhookReceiver(
      { secret: webhookSecret, logger },
      sipCoordinator,
    );
    lifecycle = sipCoordinator;
  }
  if (automaticScheduler) {
    automaticScheduler.setExecutor(async (booking) => {
      const callId = `callback-${randomUUID()}`;
      const prepared = await coordinator.prepare({
        callId,
        promptVersion: "elevatebox-scheduled-callback-v1",
        ...(booking.preferredLanguage
          ? { preferredLanguage: booking.preferredLanguage }
          : {}),
        leadContext: {
          scheduledCallback: true,
          originallyScheduledAt: booking.scheduledAt,
        },
      });
      if (prepared.provider !== "asterisk-sip") {
        await coordinator.abort(prepared.token);
        throw new Error("Automatic callback did not prepare an Asterisk SIP call");
      }
      try {
        await outboundDialer.dial({
          media: { ...prepared, ready: true, provider: "asterisk-sip" },
          to: booking.leadPhone,
          idempotencyKey: `${booking.idempotencyKey}:dial`,
        });
      } catch (error) {
        await coordinator.abort(prepared.token).catch(() => undefined);
        throw error;
      }
    });
    lifecycle = combinedLifecycle([
      ...(lifecycle ? [lifecycle] : []),
      automaticScheduler,
    ]);
  }
  const gateway = new LiveGatewayServer({
    coordinator,
    provider: config.outboundCallProvider,
    outboundDialer,
    outboundDestination: config.leadPhone,
    controlApiToken: config.controlApiToken,
    ...(config.publicMediaBaseUrl === undefined
      ? {}
      : { publicMediaBaseUrl: config.publicMediaBaseUrl }),
    ...(openAIWebhookReceiver === undefined
      ? {}
      : { openAIWebhookReceiver }),
    host: config.host,
    port: config.port,
    ...(config.mediaBasicAuth === undefined
      ? {}
      : { mediaBasicAuth: config.mediaBasicAuth }),
    logger,
  });
  return new ProductionApplication(
    gateway,
    logger,
    config.mode,
    config.outboundCallProvider === "exotel"
      ? config.exotelDialMode
      : config.sipDialMode,
    config.outboundCallProvider,
    config.whatsappMode,
    config.whatsappProvider,
    config.callbackMode,
    lifecycle,
  );
}

async function main(): Promise<void> {
  const logger = new ConsoleSanitizedLogger();
  let application: ProductionApplication | undefined;
  try {
    application = createProductionApplication(loadProductionConfig(), { logger });
    await application.start();
  } catch (error) {
    logger.error("gateway.start_failed", {
      errorRef: safeReference(error instanceof Error ? error.message : String(error)),
    });
    process.exitCode = 1;
    return;
  }

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void application?.close().catch((error: unknown) => {
      logger.error("gateway.stop_failed", {
        errorRef: safeReference(error instanceof Error ? error.message : String(error)),
      });
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}

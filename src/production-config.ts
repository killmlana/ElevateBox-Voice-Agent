export type ProductionMode = "dry-run" | "live";
export type WhatsAppProvider = "openwa" | "meta";
export type OutboundCallProvider = "asterisk-sip" | "exotel";
export type CallbackProvider = "webhook" | "automatic-sip";

export interface ProductionConfig {
  mode: ProductionMode;
  outboundCallProvider: OutboundCallProvider;
  sipDialMode: ProductionMode;
  exotelDialMode: ProductionMode;
  whatsappMode: ProductionMode;
  whatsappProvider: WhatsAppProvider;
  callbackMode: ProductionMode;
  callbackProvider: CallbackProvider;
  allowPaidSipCalls: boolean;
  allowPaidExotelCalls: boolean;
  allowRealWhatsappMessages: boolean;
  allowUnofficialWhatsappClient: boolean;
  allowLiveCallbackBookings: boolean;
  host: string;
  port: number;
  controlApiToken: string;
  publicMediaBaseUrl?: string;
  mediaBasicAuth?: { username: string; password: string };
  preparedCallTtlMs: number;
  traceDirectory: string;
  leadPhone: string;
  candidatePhone: string;
  resumePath: string;
  openai: {
    apiKey?: string;
    realtimeModel: string;
    realtimeVoice: string;
    realtimeReasoningEffort: "low" | "medium" | "high";
    realtimeMaxOutputTokens?: number | "inf";
    realtimeHandshakeTimeoutMs: number;
    transcriptionModel: string;
    leadModel: string;
    leadTimeoutMs: number;
    leadMaxOutputTokens: number;
    leadConcurrency: number;
    safetyIdentifier?: string;
    projectId?: string;
    webhookSecret?: string;
  };
  asterisk: {
    ariBaseUrl: string;
    ariUsername?: string;
    ariPassword?: string;
    ariApp: string;
    zadarmaEndpoint: string;
    openAIEndpoint: string;
    callerId?: string;
    timeoutMs: number;
    originateTimeoutSeconds: number;
  };
  exotel: {
    accountSid?: string;
    apiKey?: string;
    apiToken?: string;
    callerId?: string;
    baseUrl: string;
    timeoutMs: number;
    timeLimitSeconds: number;
  };
  whatsapp: {
    accessToken?: string;
    phoneNumberId?: string;
    graphApiVersion: string;
    templateName?: string;
    templateLanguage: string;
    timeoutMs: number;
  };
  openwa: {
    baseUrl?: string;
    apiKey?: string;
    sessionId?: string;
    timeoutMs: number;
  };
  callback: {
    webhookUrl?: string;
    signingSecret?: string;
    timeoutMs: number;
    statePath: string;
    recoveryGraceMs: number;
  };
}

function textValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  options: { required?: boolean; fallback?: string } = {},
): string {
  const value = environment[name]?.trim() || options.fallback;
  if (!value && options.required) throw new Error(`${name} is required`);
  return value ?? "";
}

function integerValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(environment[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function modeValue(value: string | undefined, name: string): ProductionMode {
  const normalized = value?.trim() || "dry-run";
  if (normalized !== "dry-run" && normalized !== "live") {
    throw new Error(`${name} must be dry-run or live`);
  }
  return normalized;
}

function whatsappProviderValue(value: string | undefined): WhatsAppProvider {
  const normalized = value?.trim().toLowerCase() || "openwa";
  if (normalized !== "openwa" && normalized !== "meta") {
    throw new Error("WHATSAPP_PROVIDER must be openwa or meta");
  }
  return normalized;
}

function outboundProviderValue(value: string | undefined): OutboundCallProvider {
  const normalized = value?.trim().toLowerCase() || "asterisk-sip";
  if (normalized !== "asterisk-sip" && normalized !== "exotel") {
    throw new Error("OUTBOUND_CALL_PROVIDER must be asterisk-sip or exotel");
  }
  return normalized;
}

function callbackProviderValue(value: string | undefined): CallbackProvider {
  const normalized = value?.trim().toLowerCase() || "webhook";
  if (normalized !== "webhook" && normalized !== "automatic-sip") {
    throw new Error("CALLBACK_PROVIDER must be webhook or automatic-sip");
  }
  return normalized;
}

function optional(value: string): string | undefined {
  return value ? value : undefined;
}

function maxOutputTokens(value: string | undefined): number | "inf" | undefined {
  if (!value?.trim()) return undefined;
  if (value.trim().toLowerCase() === "inf") return "inf";
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4096) {
    throw new Error("OPENAI_REALTIME_MAX_OUTPUT_TOKENS must be inf or 1 to 4096");
  }
  return parsed;
}

export function loadProductionConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ProductionConfig {
  const mode = modeValue(environment.ELEVATEBOX_MODE, "ELEVATEBOX_MODE");
  const outboundCallProvider = outboundProviderValue(
    environment.OUTBOUND_CALL_PROVIDER,
  );
  const sipDialMode = modeValue(environment.SIP_DIAL_MODE, "SIP_DIAL_MODE");
  const exotelDialMode = modeValue(
    environment.EXOTEL_DIAL_MODE,
    "EXOTEL_DIAL_MODE",
  );
  const whatsappMode = modeValue(environment.WHATSAPP_MODE, "WHATSAPP_MODE");
  const whatsappProvider = whatsappProviderValue(environment.WHATSAPP_PROVIDER);
  const callbackMode = modeValue(environment.CALLBACK_MODE, "CALLBACK_MODE");
  const callbackProvider = callbackProviderValue(environment.CALLBACK_PROVIDER);
  const allowPaidSipCalls =
    environment.ALLOW_PAID_SIP_CALLS === "I_UNDERSTAND_THIS_MAKES_PAID_CALLS";
  const allowPaidExotelCalls =
    environment.ALLOW_PAID_EXOTEL_CALLS === "I_UNDERSTAND_THIS_MAKES_PAID_CALLS";
  const allowRealWhatsappMessages =
    environment.ALLOW_REAL_WHATSAPP_MESSAGES ===
      "I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES";
  const allowUnofficialWhatsappClient =
    environment.ALLOW_UNOFFICIAL_WHATSAPP_CLIENT ===
      "I_ACCEPT_OPENWA_ACCOUNT_RISK";
  const allowLiveCallbackBookings =
    environment.ALLOW_LIVE_CALLBACK_BOOKINGS ===
      "I_UNDERSTAND_THIS_CREATES_REAL_CALLBACKS";
  if (
    outboundCallProvider === "asterisk-sip" &&
    sipDialMode === "live" &&
    !allowPaidSipCalls
  ) {
    throw new Error(
      "Live SIP dialing requires ALLOW_PAID_SIP_CALLS=I_UNDERSTAND_THIS_MAKES_PAID_CALLS",
    );
  }
  if (
    outboundCallProvider === "asterisk-sip" &&
    mode === "dry-run" &&
    sipDialMode === "live"
  ) {
    throw new Error("ELEVATEBOX_MODE must be live before SIP dialing can be live");
  }
  if (
    outboundCallProvider === "exotel" &&
    exotelDialMode === "live" &&
    !allowPaidExotelCalls
  ) {
    throw new Error(
      "Live Exotel dialing requires ALLOW_PAID_EXOTEL_CALLS=I_UNDERSTAND_THIS_MAKES_PAID_CALLS",
    );
  }
  if (
    outboundCallProvider === "exotel" &&
    mode === "dry-run" &&
    exotelDialMode === "live"
  ) {
    throw new Error("ELEVATEBOX_MODE must be live before Exotel dialing can be live");
  }
  if (whatsappMode === "live" && !allowRealWhatsappMessages) {
    throw new Error(
      "Live WhatsApp requires ALLOW_REAL_WHATSAPP_MESSAGES=I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES",
    );
  }
  if (
    whatsappMode === "live" &&
    whatsappProvider === "openwa" &&
    !allowUnofficialWhatsappClient
  ) {
    throw new Error(
      "Live OpenWA requires ALLOW_UNOFFICIAL_WHATSAPP_CLIENT=I_ACCEPT_OPENWA_ACCOUNT_RISK",
    );
  }
  if (callbackMode === "live" && !allowLiveCallbackBookings) {
    throw new Error(
      "Live callbacks require ALLOW_LIVE_CALLBACK_BOOKINGS=I_UNDERSTAND_THIS_CREATES_REAL_CALLBACKS",
    );
  }
  if (
    callbackMode === "live" &&
    callbackProvider === "automatic-sip" &&
    (outboundCallProvider !== "asterisk-sip" || sipDialMode !== "live")
  ) {
    throw new Error("Automatic SIP callbacks require live Asterisk SIP dialing");
  }
  if (
    mode === "dry-run" &&
    (whatsappMode === "live" || callbackMode === "live")
  ) {
    throw new Error(
      "ELEVATEBOX_MODE must be live before WhatsApp or callback adapters can be live",
    );
  }

  const publicMediaBaseUrl = textValue(environment, "PUBLIC_MEDIA_BASE_URL", {
    required: outboundCallProvider === "exotel",
  });
  if (publicMediaBaseUrl) {
    const publicMediaUrl = new URL(publicMediaBaseUrl);
    if (
      outboundCallProvider === "exotel" &&
      mode === "live" &&
      publicMediaUrl.protocol !== "wss:"
    ) {
      throw new Error("PUBLIC_MEDIA_BASE_URL must use wss:// in live mode");
    }
    if (!["ws:", "wss:"].includes(publicMediaUrl.protocol)) {
      throw new Error("PUBLIC_MEDIA_BASE_URL must use ws:// or wss://");
    }
    if (publicMediaUrl.username || publicMediaUrl.password) {
      throw new Error("PUBLIC_MEDIA_BASE_URL must not contain embedded credentials");
    }
  }

  const controlApiToken = textValue(environment, "CONTROL_API_TOKEN", {
    required: true,
  });
  if (controlApiToken.length < 16) {
    throw new Error("CONTROL_API_TOKEN must contain at least 16 characters");
  }

  const mediaUsername = textValue(environment, "MEDIA_BASIC_USERNAME");
  const mediaPassword = textValue(environment, "MEDIA_BASIC_PASSWORD");
  if (Boolean(mediaUsername) !== Boolean(mediaPassword)) {
    throw new Error(
      "MEDIA_BASIC_USERNAME and MEDIA_BASIC_PASSWORD must be configured together",
    );
  }
  const leadPhone = textValue(environment, "LEAD_PHONE", { required: true });
  if (!/^\+[1-9]\d{7,14}$/.test(leadPhone)) {
    throw new Error("LEAD_PHONE must use E.164 format");
  }

  const apiKey = textValue(environment, "OPENAI_API_KEY");
  if (mode === "live" && !apiKey) {
    throw new Error("OPENAI_API_KEY is required in live mode");
  }
  const reasoningEffort = textValue(
    environment,
    "OPENAI_REALTIME_REASONING_EFFORT",
    { fallback: "low" },
  );
  if (!(["low", "medium", "high"] as const).includes(
    reasoningEffort as "low" | "medium" | "high",
  )) {
    throw new Error("OPENAI_REALTIME_REASONING_EFFORT must be low, medium, or high");
  }

  const projectId = textValue(environment, "OPENAI_PROJECT_ID");
  const webhookSecret = textValue(environment, "OPENAI_WEBHOOK_SECRET");
  const ariUsername = textValue(environment, "ASTERISK_ARI_USERNAME");
  const ariPassword = textValue(environment, "ASTERISK_ARI_PASSWORD");
  const zadarmaCallerId = textValue(environment, "ZADARMA_CALLER_ID");
  const ariBaseUrl = textValue(environment, "ASTERISK_ARI_BASE_URL", {
    fallback: "http://127.0.0.1:8088/ari",
  });
  const ariUrl = new URL(ariBaseUrl);
  if (
    outboundCallProvider === "asterisk-sip" &&
    sipDialMode === "live"
  ) {
    if (!projectId) throw new Error("OPENAI_PROJECT_ID is required for live SIP");
    if (!webhookSecret) {
      throw new Error("OPENAI_WEBHOOK_SECRET is required for live SIP");
    }
    if (!ariUsername || !ariPassword) {
      throw new Error("ASTERISK_ARI_USERNAME and ASTERISK_ARI_PASSWORD are required for live SIP");
    }
    if (
      ariUrl.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "::1"].includes(ariUrl.hostname)
    ) {
      throw new Error("ASTERISK_ARI_BASE_URL must be a loopback http:// URL");
    }
  }

  return {
    mode,
    outboundCallProvider,
    sipDialMode,
    exotelDialMode,
    whatsappMode,
    whatsappProvider,
    callbackMode,
    callbackProvider,
    allowPaidSipCalls,
    allowPaidExotelCalls,
    allowRealWhatsappMessages,
    allowUnofficialWhatsappClient,
    allowLiveCallbackBookings,
    host: textValue(environment, "HOST", { fallback: "127.0.0.1" }),
    port: integerValue(environment, "PORT", 8080, 0, 65_535),
    controlApiToken,
    ...(publicMediaBaseUrl ? { publicMediaBaseUrl } : {}),
    ...(mediaUsername
      ? { mediaBasicAuth: { username: mediaUsername, password: mediaPassword } }
      : {}),
    preparedCallTtlMs: integerValue(
      environment,
      "PREPARED_CALL_TTL_MS",
      60_000,
      1_000,
      300_000,
    ),
    traceDirectory: textValue(environment, "ELEVATEBOX_TRACE_DIR", {
      fallback: "logs/live-calls",
    }),
    leadPhone,
    candidatePhone: textValue(environment, "ELEVATEBOX_CONTACT_NUMBER", {
      fallback: "+91-DRY-RUN",
    }),
    resumePath: textValue(environment, "ELEVATEBOX_RESUME_PATH", {
      fallback: "resume.pdf",
    }),
    openai: {
      ...(optional(apiKey) ? { apiKey } : {}),
      realtimeModel: textValue(environment, "OPENAI_REALTIME_MODEL", {
        fallback: "gpt-realtime-2.1",
      }),
      realtimeVoice: textValue(environment, "OPENAI_REALTIME_VOICE", {
        fallback: "sage",
      }),
      realtimeReasoningEffort: reasoningEffort as "low" | "medium" | "high",
      ...(maxOutputTokens(environment.OPENAI_REALTIME_MAX_OUTPUT_TOKENS) === undefined
        ? {}
        : { realtimeMaxOutputTokens: maxOutputTokens(
            environment.OPENAI_REALTIME_MAX_OUTPUT_TOKENS,
          )! }),
      realtimeHandshakeTimeoutMs: integerValue(
        environment,
        "OPENAI_REALTIME_HANDSHAKE_TIMEOUT_MS",
        10_000,
        1_000,
        60_000,
      ),
      transcriptionModel: textValue(environment, "OPENAI_TRANSCRIPTION_MODEL", {
        fallback: "gpt-live-transcribe",
      }),
      leadModel: textValue(environment, "OPENAI_LEAD_MODEL", {
        fallback: "gpt-5.4-nano",
      }),
      leadTimeoutMs: integerValue(
        environment,
        "OPENAI_LEAD_TIMEOUT_MS",
        6_000,
        1_000,
        60_000,
      ),
      leadMaxOutputTokens: integerValue(
        environment,
        "OPENAI_LEAD_MAX_OUTPUT_TOKENS",
        500,
        1,
        4096,
      ),
      leadConcurrency: integerValue(
        environment,
        "OPENAI_LEAD_CONCURRENCY",
        4,
        1,
        32,
      ),
      ...(optional(textValue(environment, "OPENAI_SAFETY_IDENTIFIER"))
        ? { safetyIdentifier: textValue(environment, "OPENAI_SAFETY_IDENTIFIER") }
        : {}),
      ...(projectId ? { projectId } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
    },
    asterisk: {
      ariBaseUrl,
      ...(ariUsername ? { ariUsername } : {}),
      ...(ariPassword ? { ariPassword } : {}),
      ariApp: textValue(environment, "ASTERISK_ARI_APP", {
        fallback: "elevatebox",
      }),
      zadarmaEndpoint: textValue(environment, "ASTERISK_ZADARMA_ENDPOINT", {
        fallback: "zadarma",
      }),
      openAIEndpoint: textValue(environment, "ASTERISK_OPENAI_ENDPOINT", {
        fallback: "openai",
      }),
      ...(zadarmaCallerId ? { callerId: zadarmaCallerId } : {}),
      timeoutMs: integerValue(
        environment,
        "ASTERISK_ARI_TIMEOUT_MS",
        8_000,
        500,
        60_000,
      ),
      originateTimeoutSeconds: integerValue(
        environment,
        "ASTERISK_ORIGINATE_TIMEOUT_SECONDS",
        30,
        1,
        300,
      ),
    },
    exotel: {
      ...(optional(textValue(environment, "EXOTEL_ACCOUNT_SID"))
        ? { accountSid: textValue(environment, "EXOTEL_ACCOUNT_SID") }
        : {}),
      ...(optional(textValue(environment, "EXOTEL_API_KEY"))
        ? { apiKey: textValue(environment, "EXOTEL_API_KEY") }
        : {}),
      ...(optional(textValue(environment, "EXOTEL_API_TOKEN"))
        ? { apiToken: textValue(environment, "EXOTEL_API_TOKEN") }
        : {}),
      ...(optional(textValue(environment, "EXOTEL_CALLER_ID"))
        ? { callerId: textValue(environment, "EXOTEL_CALLER_ID") }
        : {}),
      baseUrl: textValue(environment, "EXOTEL_API_BASE_URL", {
        fallback: "https://api.in.exotel.com",
      }),
      timeoutMs: integerValue(environment, "EXOTEL_TIMEOUT_MS", 8_000, 500, 60_000),
      timeLimitSeconds: integerValue(
        environment,
        "EXOTEL_TIME_LIMIT_SECONDS",
        600,
        1,
        14_400,
      ),
    },
    whatsapp: {
      ...(optional(textValue(environment, "WHATSAPP_ACCESS_TOKEN"))
        ? { accessToken: textValue(environment, "WHATSAPP_ACCESS_TOKEN") }
        : {}),
      ...(optional(textValue(environment, "WHATSAPP_PHONE_NUMBER_ID"))
        ? { phoneNumberId: textValue(environment, "WHATSAPP_PHONE_NUMBER_ID") }
        : {}),
      graphApiVersion: textValue(environment, "WHATSAPP_GRAPH_API_VERSION", {
        fallback: "v23.0",
      }),
      ...(optional(textValue(environment, "WHATSAPP_TEMPLATE_NAME"))
        ? { templateName: textValue(environment, "WHATSAPP_TEMPLATE_NAME") }
        : {}),
      templateLanguage: textValue(environment, "WHATSAPP_TEMPLATE_LANGUAGE", {
        fallback: "en_US",
      }),
      timeoutMs: integerValue(
        environment,
        "WHATSAPP_TIMEOUT_MS",
        8_000,
        500,
        60_000,
      ),
    },
    openwa: {
      ...(optional(textValue(environment, "OPENWA_BASE_URL"))
        ? { baseUrl: textValue(environment, "OPENWA_BASE_URL") }
        : {}),
      ...(optional(textValue(environment, "OPENWA_API_KEY"))
        ? { apiKey: textValue(environment, "OPENWA_API_KEY") }
        : {}),
      ...(optional(textValue(environment, "OPENWA_SESSION_ID"))
        ? { sessionId: textValue(environment, "OPENWA_SESSION_ID") }
        : {}),
      timeoutMs: integerValue(
        environment,
        "OPENWA_TIMEOUT_MS",
        8_000,
        500,
        60_000,
      ),
    },
    callback: {
      ...(optional(textValue(environment, "CALLBACK_WEBHOOK_URL"))
        ? { webhookUrl: textValue(environment, "CALLBACK_WEBHOOK_URL") }
        : {}),
      ...(optional(textValue(environment, "CALLBACK_WEBHOOK_SECRET"))
        ? { signingSecret: textValue(environment, "CALLBACK_WEBHOOK_SECRET") }
        : {}),
      timeoutMs: integerValue(
        environment,
        "CALLBACK_TIMEOUT_MS",
        8_000,
        500,
        60_000,
      ),
      statePath: textValue(environment, "CALLBACK_STATE_PATH", {
        fallback: `${textValue(environment, "ELEVATEBOX_TRACE_DIR", { fallback: "logs/live-calls" })}/scheduled-callbacks.json`,
      }),
      recoveryGraceMs: integerValue(
        environment,
        "CALLBACK_RECOVERY_GRACE_MS",
        15 * 60_000,
        0,
        24 * 60 * 60_000,
      ),
    },
  };
}

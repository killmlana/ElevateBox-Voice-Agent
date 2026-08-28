import { createHash } from "node:crypto";

import WebSocket, { type RawData } from "ws";

import type { TelephonyLifecycleObserver } from "../contracts.ts";
import {
  NoopSanitizedLogger,
  safeReference,
  type SanitizedLogger,
} from "./sanitized-logger.ts";

const RESOURCE_PREFIX = "elevatebox-";

export interface AsteriskResourceIds {
  aiChannelId: string;
  leadChannelId: string;
  bridgeId: string;
}

export function asteriskResourceIds(callId: string): AsteriskResourceIds {
  const digest = createHash("sha256").update(callId).digest("hex").slice(0, 20);
  const base = `${RESOURCE_PREFIX}${digest}`;
  return {
    aiChannelId: `${base}-ai`,
    leadChannelId: `${base}-lead`,
    bridgeId: `${base}-bridge`,
  };
}

export interface AsteriskChannelSnapshot {
  id: string;
  name?: string;
  state?: string;
}

export interface AsteriskBridgeSnapshot {
  id: string;
  name?: string;
  channels?: string[];
}

export interface AsteriskOriginatedLeg {
  channelId: string;
  answered: Promise<void>;
  sipCallId?: string;
}

export interface AsteriskNegotiatedFormats {
  readFormat?: string;
  writeFormat?: string;
}

export interface AsteriskControlPort {
  start(): Promise<void>;
  cleanupOrphans(): Promise<{ channels: number; bridges: number }>;
  originateOpenAI(callId: string, projectId: string): Promise<AsteriskOriginatedLeg>;
  originateLead(callId: string, to: string, callerId?: string): Promise<AsteriskOriginatedLeg>;
  startSilence(channelId: string): Promise<void>;
  stopSilence(channelId: string): Promise<void>;
  createBridge(callId: string): Promise<string>;
  addChannels(bridgeId: string, channelIds: readonly string[]): Promise<void>;
  hangupChannel(channelId: string, reason?: string): Promise<void>;
  destroyBridge(bridgeId: string): Promise<void>;
  hangupBySipCallId(sipCallId: string): Promise<number>;
  negotiatedFormats(channelId: string): Promise<AsteriskNegotiatedFormats>;
  subscribe(observer: TelephonyLifecycleObserver): () => void;
  close(): Promise<void>;
}

export interface AsteriskAriConfig {
  baseUrl: string;
  username: string;
  password: string;
  app: string;
  zadarmaEndpoint: string;
  openAIEndpoint: string;
  requestTimeoutMs?: number;
  originateTimeoutSeconds?: number;
  callIdPollIntervalMs?: number;
  callIdTimeoutMs?: number;
  logger?: SanitizedLogger;
}

export interface AsteriskEventSocketHandlers {
  open(): void;
  message(data: string): void;
  error(error: Error): void;
  close(code: number, reason: string): void;
}

export interface AsteriskEventSocket {
  close(code?: number, reason?: string): void;
}

export interface AsteriskEventSocketFactory {
  connect(options: {
    url: string;
    headers: Readonly<Record<string, string>>;
    handlers: AsteriskEventSocketHandlers;
  }): AsteriskEventSocket;
}

function messageText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

export class NodeAsteriskEventSocketFactory implements AsteriskEventSocketFactory {
  connect(options: Parameters<AsteriskEventSocketFactory["connect"]>[0]): AsteriskEventSocket {
    const socket = new WebSocket(options.url, { headers: options.headers });
    socket.on("open", options.handlers.open);
    socket.on("message", (data) => options.handlers.message(messageText(data)));
    socket.on("error", options.handlers.error);
    socket.on("unexpected-response", (_request, response) => {
      options.handlers.error(
        new Error(`Asterisk ARI event WebSocket returned HTTP ${response.statusCode}`),
      );
    });
    socket.on("close", (code, reason) => {
      options.handlers.close(code, reason.toString("utf8"));
    });
    return {
      close(code, reason): void {
        socket.close(code, reason);
      },
    };
  }
}

interface ChannelWaiter {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

class AriHttpError extends Error {
  readonly status: number;

  constructor(status: number, operation: string) {
    super(`Asterisk ARI ${operation} failed with HTTP ${status}`);
    this.status = status;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function channelSnapshot(value: unknown): AsteriskChannelSnapshot {
  const channel = asRecord(value);
  if (!channel || typeof channel.id !== "string") {
    throw new Error("Asterisk ARI returned a malformed channel");
  }
  return {
    id: channel.id,
    ...(typeof channel.name === "string" ? { name: channel.name } : {}),
    ...(typeof channel.state === "string" ? { state: channel.state } : {}),
  };
}

function bridgeSnapshot(value: unknown): AsteriskBridgeSnapshot {
  const bridge = asRecord(value);
  if (!bridge || typeof bridge.id !== "string") {
    throw new Error("Asterisk ARI returned a malformed bridge");
  }
  return {
    id: bridge.id,
    ...(typeof bridge.name === "string" ? { name: bridge.name } : {}),
    ...(Array.isArray(bridge.channels)
      ? { channels: bridge.channels.filter((item): item is string => typeof item === "string") }
      : {}),
  };
}

function destroyedStatus(event: Record<string, unknown>): string {
  const cause = Number(event.cause);
  const causeText = typeof event.cause_txt === "string"
    ? event.cause_txt.toLowerCase()
    : "";
  if (cause === 17 || causeText.includes("busy")) return "busy";
  if ([18, 19].includes(cause) || causeText.includes("no answer")) return "no-answer";
  return "failed";
}

export class AsteriskAriAdapter implements AsteriskControlPort {
  private readonly config: Required<Pick<
    AsteriskAriConfig,
    | "requestTimeoutMs"
    | "originateTimeoutSeconds"
    | "callIdPollIntervalMs"
    | "callIdTimeoutMs"
  >> & AsteriskAriConfig;
  private readonly baseUrl: URL;
  private readonly authorization: string;
  private readonly fetchFn: typeof fetch;
  private readonly socketFactory: AsteriskEventSocketFactory;
  private readonly logger: SanitizedLogger;
  private readonly observers = new Set<TelephonyLifecycleObserver>();
  private readonly answerWaiters = new Map<string, ChannelWaiter>();
  private eventSocket?: AsteriskEventSocket;
  private startPromise?: Promise<void>;
  private closed = false;

  constructor(
    config: AsteriskAriConfig,
    dependencies: {
      fetchFn?: typeof fetch;
      socketFactory?: AsteriskEventSocketFactory;
    } = {},
  ) {
    const baseUrl = new URL(config.baseUrl);
    if (!config.username.trim() || !config.password) {
      throw new Error("Asterisk ARI credentials are required");
    }
    if (!config.app.trim()) throw new Error("Asterisk ARI app is required");
    this.config = {
      ...config,
      requestTimeoutMs: config.requestTimeoutMs ?? 8_000,
      originateTimeoutSeconds: config.originateTimeoutSeconds ?? 30,
      callIdPollIntervalMs: config.callIdPollIntervalMs ?? 50,
      callIdTimeoutMs: config.callIdTimeoutMs ?? 40_000,
    };
    this.baseUrl = baseUrl;
    this.authorization = `Basic ${Buffer.from(
      `${config.username}:${config.password}`,
    ).toString("base64")}`;
    this.fetchFn = dependencies.fetchFn ?? fetch;
    this.socketFactory = dependencies.socketFactory ?? new NodeAsteriskEventSocketFactory();
    this.logger = config.logger ?? new NoopSanitizedLogger();
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Asterisk ARI adapter is closed"));
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      let opened = false;
      let timer: NodeJS.Timeout | undefined;
      const rejectBeforeOpen = (error: Error): void => {
        if (opened) {
          this.failWaiters(error);
          return;
        }
        if (timer) clearTimeout(timer);
        reject(error);
      };
      const eventUrl = new URL(this.baseUrl);
      eventUrl.protocol = eventUrl.protocol === "https:" ? "wss:" : "ws:";
      eventUrl.pathname = `${eventUrl.pathname.replace(/\/$/, "")}/events`;
      eventUrl.search = "";
      eventUrl.searchParams.set("app", this.config.app);
      this.eventSocket = this.socketFactory.connect({
        url: eventUrl.toString(),
        headers: { Authorization: this.authorization },
        handlers: {
          open: () => {
            opened = true;
            if (timer) clearTimeout(timer);
            resolve();
          },
          message: (data) => this.handleEvent(data),
          error: rejectBeforeOpen,
          close: (code, reason) => {
            if (this.closed && opened) return;
            rejectBeforeOpen(new Error(
              `Asterisk ARI event stream closed (${code}: ${reason})`,
            ));
          },
        },
      });
      timer = setTimeout(() => {
        if (opened) return;
        this.eventSocket?.close(1000, "ARI connect timeout");
        reject(new Error("Asterisk ARI event stream timed out opening"));
      }, this.config.requestTimeoutMs);
      timer.unref();
    });
    return this.startPromise;
  }

  async cleanupOrphans(): Promise<{ channels: number; bridges: number }> {
    const [channelsRaw, bridgesRaw] = await Promise.all([
      this.requestJson("GET", "/channels"),
      this.requestJson("GET", "/bridges"),
    ]);
    const channels = Array.isArray(channelsRaw)
      ? channelsRaw.map(channelSnapshot).filter((item) => item.id.startsWith(RESOURCE_PREFIX))
      : [];
    const bridges = Array.isArray(bridgesRaw)
      ? bridgesRaw.map(bridgeSnapshot).filter((item) => item.id.startsWith(RESOURCE_PREFIX))
      : [];
    await Promise.all(channels.map((item) => this.hangupChannel(item.id)));
    await Promise.all(bridges.map((item) => this.destroyBridge(item.id)));
    this.logger.info("asterisk.cleanup.completed", {
      channels: channels.length,
      bridges: bridges.length,
    });
    return { channels: channels.length, bridges: bridges.length };
  }

  async originateOpenAI(
    callId: string,
    projectId: string,
  ): Promise<AsteriskOriginatedLeg> {
    const channelId = asteriskResourceIds(callId).aiChannelId;
    const endpoint = `PJSIP/${this.config.openAIEndpoint}/sip:${projectId}@sip.api.openai.com;transport=tls`;
    const answered = this.prepareAnswerWaiter(channelId);
    try {
      await this.originate(channelId, endpoint, callId, "ai");
      const sipCallId = await this.readSipCallId(channelId);
      return { channelId, sipCallId, answered: answered.promise };
    } catch (error) {
      this.rejectAnswerWaiter(channelId, error);
      throw error;
    }
  }

  async originateLead(
    callId: string,
    to: string,
    callerId?: string,
  ): Promise<AsteriskOriginatedLeg> {
    if (!/^\+[1-9]\d{7,14}$/.test(to)) {
      throw new Error("Zadarma destination must use E.164 format");
    }
    const channelId = asteriskResourceIds(callId).leadChannelId;
    const endpoint = `PJSIP/${to}@${this.config.zadarmaEndpoint}`;
    const answered = this.prepareAnswerWaiter(channelId);
    try {
      await this.originate(channelId, endpoint, callId, "lead", callerId);
      return { channelId, answered: answered.promise };
    } catch (error) {
      this.rejectAnswerWaiter(channelId, error);
      throw error;
    }
  }

  async startSilence(channelId: string): Promise<void> {
    await this.requestJson(
      "POST",
      `/channels/${encodeURIComponent(channelId)}/silence`,
      {},
      {},
    );
  }

  async stopSilence(channelId: string): Promise<void> {
    try {
      await this.requestJson(
        "DELETE",
        `/channels/${encodeURIComponent(channelId)}/silence`,
      );
    } catch (error) {
      if (await this.tryGetChannel(channelId)) throw error;
    }
  }

  async createBridge(callId: string): Promise<string> {
    const bridgeId = asteriskResourceIds(callId).bridgeId;
    try {
      await this.requestJson(
        "POST",
        `/bridges/${encodeURIComponent(bridgeId)}`,
        { type: "mixing,proxy_media", name: bridgeId },
        {},
      );
    } catch (error) {
      const existing = await this.tryGetBridge(bridgeId);
      if (!existing) throw error;
    }
    return bridgeId;
  }

  async addChannels(
    bridgeId: string,
    channelIds: readonly string[],
  ): Promise<void> {
    if (channelIds.length === 0) throw new Error("At least one channel is required");
    try {
      await this.requestJson(
        "POST",
        `/bridges/${encodeURIComponent(bridgeId)}/addChannel`,
        { channel: channelIds.join(",") },
        {},
      );
    } catch (error) {
      const bridge = await this.tryGetBridge(bridgeId);
      if (!bridge || !channelIds.every((id) => bridge.channels?.includes(id))) {
        throw error;
      }
    }
  }

  async hangupChannel(channelId: string, reason = "normal"): Promise<void> {
    try {
      await this.requestJson(
        "DELETE",
        `/channels/${encodeURIComponent(channelId)}`,
        { reason },
      );
    } catch (error) {
      if (await this.tryGetChannel(channelId)) throw error;
    }
  }

  async destroyBridge(bridgeId: string): Promise<void> {
    try {
      await this.requestJson("DELETE", `/bridges/${encodeURIComponent(bridgeId)}`);
    } catch (error) {
      if (await this.tryGetBridge(bridgeId)) throw error;
    }
  }

  async hangupBySipCallId(sipCallId: string): Promise<number> {
    const raw = await this.requestJson("GET", "/channels");
    const channels = Array.isArray(raw) ? raw.map(channelSnapshot) : [];
    let count = 0;
    for (const channel of channels) {
      const current = await this.tryReadVariable(
        channel.id,
        "CHANNEL(pjsip,call-id)",
      );
      if (current === sipCallId) {
        // ARI accepts only its documented hangup reason enum; correlation and
        // rejection are already recorded by the coordinator.
        await this.hangupChannel(channel.id, "normal");
        count += 1;
      }
    }
    return count;
  }

  async negotiatedFormats(channelId: string): Promise<AsteriskNegotiatedFormats> {
    const [readFormat, writeFormat] = await Promise.all([
      this.tryReadVariable(channelId, "CHANNEL(audioreadformat)"),
      this.tryReadVariable(channelId, "CHANNEL(audiowriteformat)"),
    ]);
    return {
      ...(readFormat ? { readFormat } : {}),
      ...(writeFormat ? { writeFormat } : {}),
    };
  }

  subscribe(observer: TelephonyLifecycleObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.eventSocket?.close(1000, "application close");
    this.failWaiters(new Error("Asterisk ARI adapter closed"));
  }

  private async originate(
    channelId: string,
    endpoint: string,
    callId: string,
    role: "ai" | "lead",
    callerId?: string,
  ): Promise<AsteriskChannelSnapshot> {
    try {
      const raw = await this.requestJson(
        "POST",
        `/channels/${encodeURIComponent(channelId)}`,
        {
          endpoint,
          app: this.config.app,
          appArgs: `${callId},${role}`,
          timeout: this.config.originateTimeoutSeconds,
          formats: "alaw,ulaw",
          ...(callerId === undefined ? {} : { callerId }),
        },
        {
          variables: {
            ELEVATEBOX_CALL_ID: callId,
            ELEVATEBOX_LEG: role,
          },
        },
      );
      return channelSnapshot(raw);
    } catch (error) {
      const existing = await this.tryGetChannel(channelId);
      if (existing) return existing;
      throw error;
    }
  }

  private prepareAnswerWaiter(channelId: string): ChannelWaiter {
    const existing = this.answerWaiters.get(channelId);
    if (existing) return existing;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const waiter: ChannelWaiter = {
      promise,
      resolve: () => {
        if (waiter.settled) return;
        waiter.settled = true;
        clearTimeout(waiter.timer);
        this.answerWaiters.delete(channelId);
        resolvePromise();
      },
      reject: (error) => {
        if (waiter.settled) return;
        waiter.settled = true;
        clearTimeout(waiter.timer);
        this.answerWaiters.delete(channelId);
        rejectPromise(error);
      },
      timer: undefined as unknown as NodeJS.Timeout,
      settled: false,
    };
    waiter.timer = setTimeout(() => {
      waiter.reject(new Error("Asterisk channel was not answered before timeout"));
    }, this.config.originateTimeoutSeconds * 1000);
    waiter.timer.unref();
    this.answerWaiters.set(channelId, waiter);
    return waiter;
  }

  private rejectAnswerWaiter(channelId: string, error: unknown): void {
    this.answerWaiters.get(channelId)?.reject(error);
  }

  private async readSipCallId(channelId: string): Promise<string> {
    const deadline = Date.now() + this.config.callIdTimeoutMs;
    do {
      const value = await this.tryReadVariable(
        channelId,
        "CHANNEL(pjsip,call-id)",
      );
      if (value?.trim()) return value.trim();
      await delay(this.config.callIdPollIntervalMs);
    } while (Date.now() < deadline);
    throw new Error("Asterisk did not expose the PJSIP Call-ID before timeout");
  }

  private async tryReadVariable(
    channelId: string,
    variable: string,
  ): Promise<string | undefined> {
    try {
      const raw = await this.requestJson(
        "GET",
        `/channels/${encodeURIComponent(channelId)}/variable`,
        { variable },
      );
      const result = asRecord(raw);
      return typeof result?.value === "string" ? result.value : undefined;
    } catch (error) {
      if (error instanceof AriHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async tryGetChannel(
    channelId: string,
  ): Promise<AsteriskChannelSnapshot | undefined> {
    try {
      return channelSnapshot(await this.requestJson(
        "GET",
        `/channels/${encodeURIComponent(channelId)}`,
      ));
    } catch (error) {
      if (error instanceof AriHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async tryGetBridge(
    bridgeId: string,
  ): Promise<AsteriskBridgeSnapshot | undefined> {
    try {
      return bridgeSnapshot(await this.requestJson(
        "GET",
        `/bridges/${encodeURIComponent(bridgeId)}`,
      ));
    } catch (error) {
      if (error instanceof AriHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async requestJson(
    method: string,
    path: string,
    query: Readonly<Record<string, string | number | boolean>> = {},
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const url = new URL(this.baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
    url.search = "";
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: this.authorization,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response.ok) throw new AriHttpError(response.status, `${method} ${path}`);
      if (response.status === 204 || response.headers.get("content-length") === "0") {
        return undefined;
      }
      const text = await response.text();
      return text ? JSON.parse(text) as unknown : undefined;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Asterisk ARI ${method} ${path} timed out ambiguously`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private handleEvent(data: string): void {
    let event: Record<string, unknown>;
    try {
      const parsed = asRecord(JSON.parse(data));
      if (!parsed || typeof parsed.type !== "string") return;
      event = parsed;
    } catch {
      return;
    }
    const channel = asRecord(event.channel);
    const channelId = typeof channel?.id === "string" ? channel.id : undefined;
    if (!channelId) return;
    const waiter = this.answerWaiters.get(channelId);
    const type = event.type as string;
    const state = typeof channel?.state === "string" ? channel.state : undefined;
    if ((type === "ChannelStateChange" || type === "StasisStart") && state === "Up") {
      waiter?.resolve();
      this.emit("telephony.answered", { channelId });
      return;
    }
    if (type === "ChannelDestroyed") {
      const status = destroyedStatus(event);
      waiter?.reject(new Error(`Asterisk channel ended before answer: ${status}`));
      this.emit("telephony.channel_destroyed", { channelId, status });
      return;
    }
    if (type === "StasisEnd") {
      this.emit("telephony.stopped", { channelId });
      return;
    }
    if (type === "ChannelDtmfReceived") {
      this.emit("telephony.dtmf", {
        channelId,
        ...(typeof event.digit === "string" ? { digit: event.digit } : {}),
      });
    }
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    for (const observer of this.observers) observer.onEvent(type, payload);
  }

  private failWaiters(error: Error): void {
    for (const waiter of this.answerWaiters.values()) waiter.reject(error);
  }
}

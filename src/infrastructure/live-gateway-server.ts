import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import type { PreparedCallHandle } from "../application/prepared-call-coordinator.ts";
import type { SessionContext, SupportedLanguage } from "../contracts.ts";
import type { ExotelServerSocket } from "./exotel-call-adapter.ts";

export interface GatewayLiveConnection {
  receive(rawMessage: string): void;
  close(): Promise<void>;
}

export interface LiveGatewayCoordinator {
  prepare(context: SessionContext): Promise<PreparedCallHandle>;
  attach(
    token: string,
    socket: ExotelServerSocket,
  ): Promise<GatewayLiveConnection>;
  abort(token: string): Promise<void>;
}

export interface LiveGatewayAddress {
  host: string;
  port: number;
}

interface MediaBasicAuth {
  username: string;
  password: string;
}

interface LiveGatewayOptions {
  coordinator: LiveGatewayCoordinator;
  controlApiToken: string;
  publicMediaBaseUrl: string;
  host?: string;
  port?: number;
  mediaBasicAuth?: MediaBasicAuth;
  maxBodyBytes?: number;
  maxMediaPayloadBytes?: number;
  maxQueuedMediaBytes?: number;
}

type BodyReadResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; message: string };

const SUPPORTED_LANGUAGES = new Set<SupportedLanguage>([
  "EN",
  "HI",
  "TE",
  "MIXED",
  "UNKNOWN",
]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function json(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
  });
  response.end(encoded);
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function authorization(request: IncomingMessage): string {
  const value = request.headers.authorization;
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maximumLength) {
    throw new Error(`${field} must be at most ${maximumLength} characters`);
  }
  return trimmed;
}

function sessionContext(value: unknown): SessionContext {
  if (!isRecord(value)) throw new Error("Request body must be a JSON object");
  const callId = boundedText(value.callId, "callId", 128);
  const promptVersion = boundedText(value.promptVersion, "promptVersion", 128);
  const preferredLanguage = value.preferredLanguage;
  if (
    preferredLanguage !== undefined &&
    (typeof preferredLanguage !== "string" ||
      !SUPPORTED_LANGUAGES.has(preferredLanguage as SupportedLanguage))
  ) {
    throw new Error("preferredLanguage is not supported");
  }
  if (value.leadContext !== undefined && !isRecord(value.leadContext)) {
    throw new Error("leadContext must be a JSON object");
  }
  return {
    callId,
    promptVersion,
    ...(preferredLanguage === undefined
      ? {}
      : { preferredLanguage: preferredLanguage as SupportedLanguage }),
    ...(value.leadContext === undefined
      ? {}
      : { leadContext: value.leadContext }),
  };
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<BodyReadResult> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    return { ok: false, status: 415, message: "Content-Type must be application/json" };
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    request.resume();
    return { ok: false, status: 413, message: "Request body is too large" };
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maximumBytes) {
      tooLarge = true;
    } else if (!tooLarge) {
      chunks.push(buffer);
    }
  }
  if (tooLarge) {
    return { ok: false, status: 413, message: "Request body is too large" };
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, message: "Request body is not valid JSON" };
  }
}

function rejectUpgrade(socket: Duplex, status: 400 | 401 | 404): void {
  const reason = status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : "Bad Request";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

export class LiveGatewayServer {
  private readonly coordinator: LiveGatewayCoordinator;
  private readonly controlAuthorization: string;
  private readonly mediaAuthorization: string | undefined;
  private readonly publicMediaBaseUrl: URL;
  private readonly mediaPathPrefix: string;
  private readonly host: string;
  private readonly port: number;
  private readonly maxBodyBytes: number;
  private readonly maxQueuedMediaBytes: number;
  private readonly server = createServer((request, response) => {
    void this.handleRequest(request, response);
  });
  private readonly webSockets: WebSocketServer;
  private readonly liveConnections = new Set<GatewayLiveConnection>();
  private readonly attachments = new Set<Promise<void>>();
  private readonly preparedTokens = new Map<string, NodeJS.Timeout>();
  private closing = false;

  constructor(options: LiveGatewayOptions) {
    if (options.controlApiToken.length < 16) {
      throw new Error("controlApiToken must contain at least 16 characters");
    }
    this.coordinator = options.coordinator;
    this.controlAuthorization = `Bearer ${options.controlApiToken}`;
    this.publicMediaBaseUrl = new URL(options.publicMediaBaseUrl);
    if (!["ws:", "wss:"].includes(this.publicMediaBaseUrl.protocol)) {
      throw new Error("publicMediaBaseUrl must use ws:// or wss://");
    }
    this.mediaPathPrefix = `${this.publicMediaBaseUrl.pathname.replace(/\/$/, "")}/media/`;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
    this.maxQueuedMediaBytes = options.maxQueuedMediaBytes ?? 2 * 1024 * 1024;
    this.mediaAuthorization = options.mediaBasicAuth === undefined
      ? undefined
      : `Basic ${Buffer.from(
          `${options.mediaBasicAuth.username}:${options.mediaBasicAuth.password}`,
        ).toString("base64")}`;
    this.webSockets = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: options.maxMediaPayloadBytes ?? 1024 * 1024,
    });
    this.server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
  }

  async listen(): Promise<LiveGatewayAddress> {
    if (this.closing) throw new Error("Live gateway is closing");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    const address = this.server.address() as AddressInfo | null;
    if (!address) throw new Error("Live gateway did not bind to an address");
    return { host: address.address, port: address.port };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const httpClosed = new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    for (const socket of this.webSockets.clients) socket.terminate();
    await Promise.allSettled([...this.attachments]);
    await Promise.allSettled(
      [...this.liveConnections].map((connection) => connection.close()),
    );
    const pendingTokens = [...this.preparedTokens.keys()];
    for (const timeout of this.preparedTokens.values()) clearTimeout(timeout);
    this.preparedTokens.clear();
    await Promise.allSettled(
      pendingTokens.map((token) => this.coordinator.abort(token)),
    );
    await httpClosed;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://gateway.local");
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { status: "ok" });
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/calls/prepare") {
        json(response, 404, { error: "Not found" });
        return;
      }
      if (!constantTimeEqual(authorization(request), this.controlAuthorization)) {
        response.setHeader("www-authenticate", "Bearer");
        json(response, 401, { error: "Unauthorized" });
        return;
      }
      const body = await readJsonBody(request, this.maxBodyBytes);
      if (!body.ok) {
        json(response, body.status, { error: body.message });
        return;
      }
      let context: SessionContext;
      try {
        context = sessionContext(body.value);
      } catch (error) {
        json(response, 400, {
          error: error instanceof Error ? error.message : "Invalid request",
        });
        return;
      }
      const prepared = await this.coordinator.prepare(context);
      this.rememberPrepared(prepared);
      if (response.destroyed) {
        await this.abortPrepared(prepared.token);
        return;
      }
      try {
        json(response, 201, {
          callId: prepared.callId,
          token: prepared.token,
          expiresAt: prepared.expiresAt,
          streamUrl: this.streamUrl(prepared.token),
        });
      } catch (error) {
        await this.abortPrepared(prepared.token);
        throw error;
      }
    } catch {
      if (!response.headersSent) json(response, 503, { error: "Call preparation failed" });
      else response.end();
    }
  }

  private streamUrl(token: string): string {
    const url = new URL(this.publicMediaBaseUrl);
    const basePath = url.pathname.replace(/\/$/, "");
    url.pathname = `${basePath}/media/${encodeURIComponent(token)}`;
    url.search = "";
    url.hash = "";
    url.searchParams.set("sample-rate", "24000");
    return url.toString();
  }

  private rememberPrepared(prepared: PreparedCallHandle): void {
    const expiresAtMs = Date.parse(prepared.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      void this.coordinator.abort(prepared.token).catch(() => undefined);
      throw new Error("Coordinator returned an invalid token expiry");
    }
    const timeout = setTimeout(() => {
      this.preparedTokens.delete(prepared.token);
      void this.coordinator.abort(prepared.token).catch(() => undefined);
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, expiresAtMs - Date.now())));
    timeout.unref();
    this.preparedTokens.set(prepared.token, timeout);
  }

  private async abortPrepared(token: string): Promise<void> {
    const timeout = this.preparedTokens.get(token);
    if (timeout) clearTimeout(timeout);
    this.preparedTokens.delete(token);
    await this.coordinator.abort(token);
  }

  private consumePrepared(token: string): void {
    const timeout = this.preparedTokens.get(token);
    if (timeout) clearTimeout(timeout);
    this.preparedTokens.delete(token);
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (this.closing) {
      rejectUpgrade(socket, 404);
      return;
    }
    let token: string | undefined;
    try {
      const url = new URL(request.url ?? "/", "http://gateway.local");
      if (url.pathname.startsWith(this.mediaPathPrefix)) {
        const encodedToken = url.pathname.slice(this.mediaPathPrefix.length);
        if (encodedToken.length > 0 && !encodedToken.includes("/")) {
          token = decodeURIComponent(encodedToken);
        }
      }
    } catch {
      rejectUpgrade(socket, 400);
      return;
    }
    if (!token) {
      rejectUpgrade(socket, 404);
      return;
    }
    if (
      this.mediaAuthorization !== undefined &&
      !constantTimeEqual(authorization(request), this.mediaAuthorization)
    ) {
      rejectUpgrade(socket, 401);
      return;
    }
    this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      this.webSockets.emit("connection", webSocket, request);
      const attachment = this.attach(webSocket, token);
      this.attachments.add(attachment);
      void attachment.finally(() => this.attachments.delete(attachment));
    });
  }

  private async attach(webSocket: WebSocket, token: string): Promise<void> {
    let live: GatewayLiveConnection | undefined;
    let peerClosed = false;
    let closeTask: Promise<void> | undefined;
    const queuedMessages: string[] = [];
    let queuedBytes = 0;

    const closeLive = (): Promise<void> => {
      if (!live) return Promise.resolve();
      closeTask ??= live
        .close()
        .catch(() => undefined)
        .finally(() => {
          if (live) this.liveConnections.delete(live);
        });
      return closeTask;
    };
    webSocket.once("close", () => {
      peerClosed = true;
      void closeLive();
    });
    webSocket.once("error", () => {
      peerClosed = true;
      void closeLive();
    });
    webSocket.on("message", (data, isBinary) => {
      if (isBinary) {
        webSocket.close(1003, "Text messages required");
        return;
      }
      const message = rawDataText(data);
      if (live) {
        live.receive(message);
        return;
      }
      queuedBytes += Buffer.byteLength(message);
      if (queuedBytes > this.maxQueuedMediaBytes) {
        webSocket.close(1009, "Queued media limit exceeded");
        return;
      }
      queuedMessages.push(message);
    });

    try {
      this.consumePrepared(token);
      live = await this.coordinator.attach(token, {
        send(data): void {
          if (webSocket.readyState === WebSocket.OPEN) webSocket.send(data);
        },
      });
      this.liveConnections.add(live);
      if (peerClosed || webSocket.readyState !== WebSocket.OPEN) {
        await closeLive();
        return;
      }
      for (const message of queuedMessages) live.receive(message);
    } catch (error) {
      const invalidToken = error instanceof Error && /token|expired|already used/i.test(error.message);
      if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.close(invalidToken ? 1008 : 1011, invalidToken ? "Invalid media token" : "Call attachment failed");
      }
      await closeLive();
    }
  }
}

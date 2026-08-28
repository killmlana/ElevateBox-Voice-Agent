import { randomUUID } from "node:crypto";

import type {
  OutboundCallProvider,
  OutboundDialAdapter,
  OutboundDialRequest,
  OutboundDialResult,
  ReadyPreparedCall,
  SessionContext,
} from "../contracts.ts";
import { safeReference } from "./sanitized-logger.ts";

interface PendingCapability {
  callId: string;
  token: string;
  expiresAtMs: number;
}

/** No-network preparation used by the default Asterisk SIP dry run. */
export class DryRunPreparedCallCoordinator {
  private readonly provider: OutboundCallProvider;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private pending: PendingCapability | undefined;

  constructor(options: {
    provider?: OutboundCallProvider;
    ttlMs?: number;
    now?: () => number;
    tokenFactory?: () => string;
  } = {}) {
    this.provider = options.provider ?? "asterisk-sip";
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
  }

  async prepare(context: SessionContext): Promise<ReadyPreparedCall> {
    if (this.pending && this.pending.expiresAtMs > this.now()) {
      throw new Error("Only one preparing or active dry-run call is supported");
    }
    const token = this.tokenFactory();
    const expiresAtMs = this.now() + this.ttlMs;
    this.pending = { callId: context.callId, token, expiresAtMs };
    return {
      ready: true,
      callId: context.callId,
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      provider: this.provider,
    };
  }

  async abort(token: string): Promise<void> {
    if (this.pending?.token === token) this.pending = undefined;
  }
}

/** Deterministic no-network dial result for SIP dry-run deployments. */
export class DryRunOutboundDialAdapter implements OutboundDialAdapter {
  private readonly provider: OutboundCallProvider;
  private readonly now: () => number;
  private readonly requests = new Map<string, {
    fingerprint: string;
    result: Promise<OutboundDialResult>;
  }>();

  constructor(
    provider: OutboundCallProvider = "asterisk-sip",
    now: () => number = Date.now,
  ) {
    this.provider = provider;
    this.now = now;
  }

  dial(request: OutboundDialRequest): Promise<OutboundDialResult> {
    const fingerprint = JSON.stringify({
      callId: request.media.callId,
      token: request.media.token,
      provider: request.media.provider,
      to: request.to,
    });
    const existing = this.requests.get(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new Error("Dry-run idempotency key conflict"));
      }
      return existing.result;
    }
    if (request.media.provider !== this.provider) {
      return Promise.reject(new Error("Prepared call provider does not match dialer"));
    }
    if (Date.parse(request.media.expiresAt) <= this.now()) {
      return Promise.reject(new Error("Prepared call expired before dry-run dial"));
    }
    const result = Promise.resolve({
      providerCallId: `dryrun_${safeReference(request.idempotencyKey)}`,
      status: "simulated",
      simulated: true,
    });
    this.requests.set(request.idempotencyKey, { fingerprint, result });
    return result;
  }
}

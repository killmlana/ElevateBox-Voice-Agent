import { randomUUID } from "node:crypto";

import type {
  ConversationRuntime,
  ConversationSessionPort,
  SessionContext,
} from "../contracts.ts";
import {
  ExotelCallAdapter,
  type ExotelCallObserver,
  type ExotelServerSocket,
} from "../infrastructure/exotel-call-adapter.ts";

interface PreparedCall {
  session: ConversationSessionPort;
  expiresAtMs: number;
}

export interface PreparedCallHandle {
  token: string;
  callId: string;
  expiresAt: string;
}

/**
 * The dialer must call prepare() first and may dial only after it resolves.
 * This removes the Realtime WebSocket handshake from post-answer latency.
 */
export class PreparedCallCoordinator {
  private readonly runtime: ConversationRuntime;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private readonly prepared = new Map<string, PreparedCall>();

  constructor(
    runtime: ConversationRuntime,
    options: {
      ttlMs?: number;
      now?: () => number;
      tokenFactory?: () => string;
    } = {},
  ) {
    this.runtime = runtime;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
  }

  async prepare(context: SessionContext): Promise<PreparedCallHandle> {
    const session = await this.runtime.createSession(context);
    let token: string | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = this.tokenFactory();
      if (!this.prepared.has(candidate)) {
        token = candidate;
        break;
      }
    }
    if (!token) {
      await session.close();
      throw new Error("Could not allocate a unique prepared-call token");
    }
    const expiresAtMs = this.now() + this.ttlMs;
    this.prepared.set(token, { session, expiresAtMs });
    return {
      token,
      callId: context.callId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async attach(
    token: string,
    socket: ExotelServerSocket,
    observer?: ExotelCallObserver,
  ): Promise<ExotelCallAdapter> {
    const session = await this.claim(token);
    return new ExotelCallAdapter(
      socket,
      session,
      observer ? { observer } : {},
    );
  }

  async claim(token: string): Promise<ConversationSessionPort> {
    const prepared = this.prepared.get(token);
    if (!prepared) throw new Error("Prepared call token is invalid or already used");
    this.prepared.delete(token);
    if (prepared.expiresAtMs <= this.now()) {
      await prepared.session.close();
      throw new Error("Prepared call token expired before Exotel connected");
    }
    return prepared.session;
  }

  async abort(token: string): Promise<void> {
    const prepared = this.prepared.get(token);
    if (!prepared) return;
    this.prepared.delete(token);
    await prepared.session.close();
  }

  async sweepExpired(): Promise<number> {
    const expired = [...this.prepared.entries()].filter(
      ([, value]) => value.expiresAtMs <= this.now(),
    );
    for (const [token, value] of expired) {
      this.prepared.delete(token);
      await value.session.close();
    }
    return expired.length;
  }

  pendingCount(): number {
    return this.prepared.size;
  }
}

import assert from "node:assert/strict";
import test from "node:test";

import { PreparedCallCoordinator } from "../src/application/prepared-call-coordinator.ts";
import type {
  AudioFrame,
  ConversationDirective,
  ConversationRuntime,
  ConversationSessionPort,
  SessionContext,
  VoiceRuntimeEvent,
} from "../src/contracts.ts";

class ReadySession implements ConversationSessionPort {
  closed = false;

  async startConversation(_instruction?: string): Promise<void> {}
  async setPreferredLanguage(_language: import("../src/contracts.ts").SupportedLanguage): Promise<void> {}
  async sendAudio(_frame: AudioFrame): Promise<void> {}
  async sendDirective(_directive: ConversationDirective): Promise<void> {}
  async interruptOutput(_playedAudioMs: number): Promise<void> {}
  async *events(): AsyncIterable<VoiceRuntimeEvent> {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

class ControlledRuntime implements ConversationRuntime {
  readonly capabilities = {
    bargeIn: true,
    serverVad: true,
    nativeAudio: true,
    languages: ["UNKNOWN" as const],
  };
  createCount = 0;
  resolveSession?: (session: ConversationSessionPort) => void;

  async createSession(_context: SessionContext): Promise<ConversationSessionPort> {
    this.createCount += 1;
    return new Promise((resolve) => {
      this.resolveSession = resolve;
    });
  }
}

test("does not release a dial token until the voice session is READY", async () => {
  const runtime = new ControlledRuntime();
  const coordinator = new PreparedCallCoordinator(runtime, {
    tokenFactory: () => "prepared-token",
    now: () => Date.parse("2026-08-26T10:00:00.000Z"),
  });
  let released = false;
  const pending = coordinator
    .prepare({ callId: "call-1", promptVersion: "v1" })
    .then((handle) => {
      released = true;
      return handle;
    });
  await Promise.resolve();
  assert.equal(released, false);

  runtime.resolveSession?.(new ReadySession());
  const handle = await pending;
  assert.equal(handle.token, "prepared-token");
  assert.equal(coordinator.pendingCount(), 1);

  const adapter = await coordinator.attach(handle.token, { send() {} });
  assert.equal(runtime.createCount, 1, "attach reuses the prewarmed session");
  assert.equal(coordinator.pendingCount(), 0);
  await assert.rejects(
    coordinator.attach(handle.token, { send() {} }),
    /already used/,
  );
  await adapter.close();
});

test("closes prepared sessions that expire before Exotel connects", async () => {
  let nowMs = 1_000;
  const session = new ReadySession();
  const runtime: ConversationRuntime = {
    capabilities: {
      bargeIn: true,
      serverVad: true,
      nativeAudio: true,
      languages: ["UNKNOWN"],
    },
    async createSession() {
      return session;
    },
  };
  const coordinator = new PreparedCallCoordinator(runtime, {
    ttlMs: 500,
    now: () => nowMs,
    tokenFactory: () => "expiring-token",
  });
  await coordinator.prepare({ callId: "call-2", promptVersion: "v1" });
  nowMs = 1_501;

  assert.equal(await coordinator.sweepExpired(), 1);
  assert.equal(session.closed, true);
  assert.equal(coordinator.pendingCount(), 0);
});

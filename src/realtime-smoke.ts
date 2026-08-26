import { NodeRealtimeSocketFactory } from "./infrastructure/node-realtime-socket.ts";
import { OpenAIRealtimeRuntime } from "./infrastructure/openai-realtime-runtime.ts";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error("Set OPENAI_API_KEY before running npm run smoke:realtime");
}

const startedAt = performance.now();
const handshakeTimeoutMs = Number(process.env.OPENAI_REALTIME_HANDSHAKE_TIMEOUT_MS ?? 10_000);

const runtime = new OpenAIRealtimeRuntime(
  {
    apiKey,
    instructions:
      "You are a concise sales qualification assistant. Do not claim an external action succeeded unless an application state update explicitly confirms it.",
    ...(process.env.OPENAI_REALTIME_MODEL
      ? { model: process.env.OPENAI_REALTIME_MODEL }
      : {}),
    ...(process.env.OPENAI_REALTIME_VOICE
      ? { voice: process.env.OPENAI_REALTIME_VOICE }
      : {}),
    handshakeTimeoutMs,
    languages: ["EN", "HI", "TE", "MIXED"],
    inputTranscriptionModel:
      process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-live-transcribe",
    ...(process.env.OPENAI_SAFETY_IDENTIFIER
      ? { safetyIdentifier: process.env.OPENAI_SAFETY_IDENTIFIER }
      : {}),
  },
  new NodeRealtimeSocketFactory(),
);

const session = await runtime.createSession({
  callId: `smoke-${Date.now()}`,
  promptVersion: "smoke-v1",
});

console.log(JSON.stringify({
  status: "ready",
  model: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1",
  handshakeMs: Math.round((performance.now() - startedAt) * 100) / 100,
  note: "No audio was sent; this smoke test does not create a phone call.",
}));
await session.close();

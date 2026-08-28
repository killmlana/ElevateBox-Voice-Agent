import assert from "node:assert/strict";
import test from "node:test";

import { LiveCallLatencyRecorder } from "../src/application/live-call-latency.ts";

test("derives turn, media handoff, and barge-in latency without entering P0", () => {
  let nowMs = 0;
  const recorder = new LiveCallLatencyRecorder(
    () => nowMs,
    () => new Date("2026-08-26T10:00:00.000Z"),
  );
  recorder.recordPrewarm(25);

  nowMs = 100;
  recorder.onEvent("telephony.media_received", {});
  nowMs = 115;
  recorder.onEvent("user.speech_stopped", {});
  nowMs = 200;
  recorder.onEvent("audio.output.delta", {});
  nowMs = 205;
  recorder.onEvent("audio.output.delta", {});
  nowMs = 210;
  recorder.onEvent("telephony.media_sent", {});
  nowMs = 300;
  recorder.onEvent("user.speech_started", {});
  nowMs = 302;
  recorder.onEvent("telephony.playback_cleared", {});

  const values = Object.fromEntries(
    recorder.measurements().map((item) => [item.name, item.valueMs]),
  );
  assert.equal(values.realtime_prewarm_ms, 25);
  assert.equal(values.last_input_media_to_speech_stop_ms, 15);
  assert.equal(values.speech_stop_to_first_model_audio_ms, 85);
  assert.equal(values.model_audio_to_telephony_send_ms, 10);
  assert.equal(values.barge_in_to_playback_clear_ms, 2);
  assert.equal(recorder.summary().speech_stop_to_first_model_audio_ms?.p95Ms, 85);
});

test("records SIP readiness, response-start, and acknowledged cancellation latency", () => {
  let nowMs = 0;
  const recorder = new LiveCallLatencyRecorder(
    () => nowMs,
    () => new Date("2026-08-27T10:00:00.000Z"),
  );
  recorder.recordSipReadiness(42);
  nowMs = 100;
  recorder.onEvent("telephony.answered", { provider: "zadarma" });
  nowMs = 112;
  recorder.onEvent("telephony.started", { provider: "asterisk-sip" });
  nowMs = 145;
  recorder.onEvent("model.response.started", {});
  nowMs = 200;
  recorder.onEvent("user.speech_stopped", {});
  nowMs = 230;
  recorder.onEvent("model.response.started", {});
  nowMs = 300;
  recorder.onEvent("user.speech_started", {});
  nowMs = 301;
  recorder.onEvent("sip.response_cancel_sent", {});
  nowMs = 307;
  recorder.onEvent("sip.response_cancelled", {});

  assert.deepEqual(
    Object.fromEntries(recorder.measurements().map((item) => [item.name, item.valueMs])),
    {
      openai_sip_readiness_ms: 42,
      pstn_answer_to_bridge_ms: 12,
      bridge_to_first_model_response_ms: 33,
      speech_stop_to_first_model_response_ms: 30,
      sip_barge_in_cancel_dispatch_ms: 1,
      sip_barge_in_cancel_ack_ms: 7,
    },
  );
});

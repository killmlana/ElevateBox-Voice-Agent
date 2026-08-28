import type { TelephonyLifecycleObserver } from "../contracts.ts";

export type LatencyMetricName =
  | "realtime_prewarm_ms"
  | "openai_sip_readiness_ms"
  | "pstn_answer_to_bridge_ms"
  | "bridge_to_first_model_response_ms"
  | "speech_stop_to_first_model_response_ms"
  | "sip_barge_in_cancel_dispatch_ms"
  | "sip_barge_in_cancel_ack_ms"
  | "last_input_media_to_speech_stop_ms"
  | "speech_stop_to_first_model_audio_ms"
  | "model_audio_to_telephony_send_ms"
  | "barge_in_to_playback_clear_ms";

export interface LatencyMeasurement {
  name: LatencyMetricName;
  valueMs: number;
  measuredAt: string;
}

export interface LatencySummary {
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
}

export class LiveCallLatencyRecorder implements TelephonyLifecycleObserver {
  private readonly monotonicNow: () => number;
  private readonly wallNow: () => Date;
  private readonly values: LatencyMeasurement[] = [];
  private lastInputMediaAt: number | undefined;
  private speechStoppedAt: number | undefined;
  private firstModelAudioAt: number | undefined;
  private bargeInAt: number | undefined;
  private pstnAnsweredAt: number | undefined;
  private bridgedAt: number | undefined;

  constructor(
    monotonicNow: () => number = () => performance.now(),
    wallNow: () => Date = () => new Date(),
  ) {
    this.monotonicNow = monotonicNow;
    this.wallNow = wallNow;
  }

  recordPrewarm(valueMs: number): void {
    this.record("realtime_prewarm_ms", valueMs);
  }

  recordSipReadiness(valueMs: number): void {
    this.record("openai_sip_readiness_ms", valueMs);
  }

  onEvent(type: string, _payload: Record<string, unknown>): void {
    const now = this.monotonicNow();
    if (type === "telephony.answered") {
      this.pstnAnsweredAt = now;
      return;
    }
    if (type === "telephony.started" && this.pstnAnsweredAt !== undefined) {
      this.record("pstn_answer_to_bridge_ms", now - this.pstnAnsweredAt);
      this.bridgedAt = now;
      return;
    }
    if (type === "telephony.media_received") {
      this.lastInputMediaAt = now;
      return;
    }
    if (type === "user.speech_stopped") {
      if (this.lastInputMediaAt !== undefined) {
        this.record(
          "last_input_media_to_speech_stop_ms",
          now - this.lastInputMediaAt,
        );
      }
      this.speechStoppedAt = now;
      this.firstModelAudioAt = undefined;
      return;
    }
    if (type === "model.response.started") {
      if (this.bridgedAt !== undefined) {
        this.record("bridge_to_first_model_response_ms", now - this.bridgedAt);
        this.bridgedAt = undefined;
      }
      if (this.speechStoppedAt !== undefined) {
        this.record("speech_stop_to_first_model_response_ms", now - this.speechStoppedAt);
        this.speechStoppedAt = undefined;
      }
      return;
    }
    if (type === "audio.output.delta" && this.firstModelAudioAt === undefined) {
      if (this.speechStoppedAt !== undefined) {
        this.record(
          "speech_stop_to_first_model_audio_ms",
          now - this.speechStoppedAt,
        );
      }
      this.firstModelAudioAt = now;
      return;
    }
    if (type === "telephony.media_sent" && this.firstModelAudioAt !== undefined) {
      this.record(
        "model_audio_to_telephony_send_ms",
        now - this.firstModelAudioAt,
      );
      this.firstModelAudioAt = undefined;
      return;
    }
    if (type === "user.speech_started") {
      this.bargeInAt = now;
      return;
    }
    if (type === "telephony.playback_cleared" && this.bargeInAt !== undefined) {
      this.record("barge_in_to_playback_clear_ms", now - this.bargeInAt);
      this.bargeInAt = undefined;
      return;
    }
    if (type === "sip.response_cancel_sent" && this.bargeInAt !== undefined) {
      this.record("sip_barge_in_cancel_dispatch_ms", now - this.bargeInAt);
      return;
    }
    if (type === "sip.response_cancelled" && this.bargeInAt !== undefined) {
      this.record("sip_barge_in_cancel_ack_ms", now - this.bargeInAt);
      this.bargeInAt = undefined;
    }
  }

  measurements(): LatencyMeasurement[] {
    return structuredClone(this.values);
  }

  summary(): Partial<Record<LatencyMetricName, LatencySummary>> {
    const grouped = new Map<LatencyMetricName, number[]>();
    for (const item of this.values) {
      const values = grouped.get(item.name) ?? [];
      values.push(item.valueMs);
      grouped.set(item.name, values);
    }
    const result: Partial<Record<LatencyMetricName, LatencySummary>> = {};
    for (const [name, unsorted] of grouped) {
      const values = [...unsorted].sort((left, right) => left - right);
      result[name] = {
        count: values.length,
        minMs: values[0] ?? 0,
        p50Ms: percentile(values, 0.5),
        p95Ms: percentile(values, 0.95),
        maxMs: values.at(-1) ?? 0,
      };
    }
    return result;
  }

  private record(name: LatencyMetricName, rawValueMs: number): void {
    const valueMs = Math.max(0, rawValueMs);
    this.values.push({
      name,
      valueMs,
      measuredAt: this.wallNow().toISOString(),
    });
  }
}

import type {
  AudioFrame,
  ConversationSessionPort,
  TelephonyLifecycleObserver,
  VoiceRuntimeEvent,
} from "../contracts.ts";
import { SerialTaskQueue } from "../application/serial-task-queue.ts";

const SAMPLE_RATE_HZ = 24000;
const BYTES_PER_SAMPLE = 2;
const EXOTEL_MIN_CHUNK_BYTES = 3200;

export interface ExotelServerSocket {
  send(data: string): void;
}

/** @deprecated Use the provider-neutral lifecycle observer. */
export type ExotelCallObserver = TelephonyLifecycleObserver;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function byteDurationMs(byteCount: number): number {
  return (byteCount / (SAMPLE_RATE_HZ * BYTES_PER_SAMPLE)) * 1000;
}

/**
 * Keeps both providers on mono linear16/24 kHz. It only performs the minimum
 * packet aggregation required by Exotel; it never resamples or transcodes.
 */
export class ExotelPcmMediaGateway {
  private pendingOutput = new Uint8Array(0);

  inboundFrame(payload: string, timestampMs: number): AudioFrame {
    return {
      data: base64ToBytes(payload),
      sampleRateHz: SAMPLE_RATE_HZ,
      encoding: "pcm16",
      timestampMs,
    };
  }

  pushOutput(frame: AudioFrame): Uint8Array[] {
    this.assertCanonical(frame);
    const combined = new Uint8Array(this.pendingOutput.length + frame.data.length);
    combined.set(this.pendingOutput);
    combined.set(frame.data, this.pendingOutput.length);

    const chunks: Uint8Array[] = [];
    let offset = 0;
    while (combined.length - offset >= EXOTEL_MIN_CHUNK_BYTES) {
      chunks.push(combined.slice(offset, offset + EXOTEL_MIN_CHUNK_BYTES));
      offset += EXOTEL_MIN_CHUNK_BYTES;
    }
    this.pendingOutput = combined.slice(offset);
    return chunks;
  }

  flushOutput(): Uint8Array[] {
    if (this.pendingOutput.length === 0) return [];
    const padded = new Uint8Array(EXOTEL_MIN_CHUNK_BYTES);
    padded.set(this.pendingOutput);
    this.pendingOutput = new Uint8Array(0);
    return [padded];
  }

  clearOutput(): void {
    this.pendingOutput = new Uint8Array(0);
  }

  private assertCanonical(frame: AudioFrame): void {
    if (frame.encoding !== "pcm16" || frame.sampleRateHz !== SAMPLE_RATE_HZ) {
      throw new Error("Exotel output must be mono pcm16 at 24000 Hz");
    }
  }
}

interface PlaybackMark {
  itemId: string;
  audioEndMs: number;
}

export class ExotelCallAdapter {
  private readonly socket: ExotelServerSocket;
  private readonly conversation: ConversationSessionPort;
  private readonly media: ExotelPcmMediaGateway;
  private readonly observer: ExotelCallObserver | undefined;
  private readonly inputQueue = new SerialTaskQueue();
  private readonly playbackMarks = new Map<string, PlaybackMark>();
  private readonly outputTask: Promise<void>;
  private streamSid?: string;
  private currentItemId?: string;
  private sentItemAudioMs = 0;
  private playedItemAudioMs = 0;
  private markSequence = 0;
  private closed = false;
  private outputFailure?: unknown;

  constructor(
    socket: ExotelServerSocket,
    readyConversation: ConversationSessionPort,
    options: {
      mediaGateway?: ExotelPcmMediaGateway;
      observer?: ExotelCallObserver;
    } = {},
  ) {
    this.socket = socket;
    this.conversation = readyConversation;
    this.media = options.mediaGateway ?? new ExotelPcmMediaGateway();
    this.observer = options.observer;
    this.outputTask = this.forwardConversationEvents().catch((error: unknown) => {
      this.outputFailure = error;
      this.observer?.onEvent("call.adapter_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  receive(rawMessage: string): void {
    this.inputQueue.enqueue(() => this.handleExotelMessage(rawMessage));
  }

  async idle(): Promise<void> {
    await this.inputQueue.idle();
    await Promise.resolve();
    if (this.outputFailure) throw this.outputFailure;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.conversation.close();
    await this.outputTask;
  }

  async handleRuntimeEvent(event: VoiceRuntimeEvent): Promise<void> {
    if (event.type === "audio.output.delta") {
      const frame = event.payload.frame;
      if (!this.isAudioFrame(frame)) {
        throw new Error("Conversation runtime emitted an invalid audio frame");
      }
      const itemId =
        typeof event.payload.itemId === "string"
          ? event.payload.itemId
          : this.currentItemId ?? "assistant-current";
      if (itemId !== this.currentItemId) this.beginOutputItem(itemId);
      this.observer?.onEvent(event.type, event.payload);
      for (const chunk of this.media.pushOutput(frame)) this.sendAudioChunk(chunk);
      return;
    }

    if (
      event.type === "agent.turn.completed" ||
      event.type === "response.output_audio.done" ||
      event.type === "response.done"
    ) {
      for (const chunk of this.media.flushOutput()) this.sendAudioChunk(chunk);
      this.observer?.onEvent(event.type, event.payload);
      return;
    }

    if (event.type === "user.speech_started") {
      this.observer?.onEvent(event.type, {
        ...event.payload,
        playedAudioMs: this.playedItemAudioMs,
      });
      this.clearPlayback();
      await this.conversation.interruptOutput(this.playedItemAudioMs);
      this.observer?.onEvent("model.output_truncated", {
        playedAudioMs: this.playedItemAudioMs,
      });
      return;
    }

    this.observer?.onEvent(event.type, event.payload);
  }

  private async handleExotelMessage(rawMessage: string): Promise<void> {
    const parsed = JSON.parse(rawMessage) as unknown;
    const event = asRecord(parsed);
    if (!event || typeof event.event !== "string") {
      throw new Error("Exotel message must contain an event");
    }

    switch (event.event) {
      case "connected":
        this.observer?.onEvent("telephony.connected", event);
        return;
      case "start":
        this.handleStart(event);
        return;
      case "media":
        await this.handleInboundMedia(event);
        return;
      case "mark":
        this.handlePlaybackMark(event);
        return;
      case "dtmf":
        this.observer?.onEvent("telephony.dtmf", event);
        return;
      case "stop":
        this.observer?.onEvent("telephony.stopped", event);
        await this.close();
        return;
      default:
        this.observer?.onEvent("telephony.unknown_event", event);
    }
  }

  private handleStart(event: Record<string, unknown>): void {
    const start = asRecord(event.start);
    const mediaFormat = asRecord(start?.media_format);
    const streamSid = start?.stream_sid ?? event.stream_sid;
    if (typeof streamSid !== "string") throw new Error("Exotel start lacks stream_sid");
    if (
      mediaFormat?.encoding !== "audio/x-raw" ||
      Number(mediaFormat.sample_rate) !== SAMPLE_RATE_HZ ||
      Number(mediaFormat.bit_rate) !== 16
    ) {
      throw new Error(
        "Configure Exotel VoiceBot with raw linear16 at 24000 Hz to avoid transcoding",
      );
    }
    this.streamSid = streamSid;
    this.observer?.onEvent("telephony.started", {
      streamSid,
      callSid: start?.call_sid,
      sampleRateHz: SAMPLE_RATE_HZ,
    });
  }

  private async handleInboundMedia(event: Record<string, unknown>): Promise<void> {
    if (!this.streamSid) throw new Error("Exotel media arrived before start");
    const media = asRecord(event.media);
    if (!media || typeof media.payload !== "string") {
      throw new Error("Exotel media lacks a Base64 payload");
    }
    const timestampMs = Number(media.timestamp);
    const frame = this.media.inboundFrame(
      media.payload,
      Number.isFinite(timestampMs) ? timestampMs : Date.now(),
    );
    this.observer?.onEvent("telephony.media_received", {
      byteLength: frame.data.byteLength,
      mediaTimestampMs: frame.timestampMs,
    });
    await this.conversation.sendAudio(frame);
  }

  private handlePlaybackMark(event: Record<string, unknown>): void {
    const mark = asRecord(event.mark);
    if (!mark || typeof mark.name !== "string") return;
    const playback = this.playbackMarks.get(mark.name);
    if (!playback) return;
    this.playbackMarks.delete(mark.name);
    if (playback.itemId === this.currentItemId) {
      this.playedItemAudioMs = Math.max(
        this.playedItemAudioMs,
        playback.audioEndMs,
      );
      this.observer?.onEvent("telephony.playback_mark", {
        itemId: playback.itemId,
        audioEndMs: playback.audioEndMs,
      });
    }
  }

  private async forwardConversationEvents(): Promise<void> {
    for await (const event of this.conversation.events()) {
      await this.handleRuntimeEvent(event);
    }
  }

  private beginOutputItem(itemId: string): void {
    this.media.clearOutput();
    this.playbackMarks.clear();
    this.currentItemId = itemId;
    this.sentItemAudioMs = 0;
    this.playedItemAudioMs = 0;
  }

  private sendAudioChunk(chunk: Uint8Array): void {
    const streamSid = this.requireStreamSid();
    this.socket.send(
      JSON.stringify({
        event: "media",
        stream_sid: streamSid,
        media: { payload: bytesToBase64(chunk) },
      }),
    );
    this.sentItemAudioMs += byteDurationMs(chunk.length);
    this.observer?.onEvent("telephony.media_sent", {
      itemId: this.currentItemId,
      byteLength: chunk.byteLength,
      audioEndMs: this.sentItemAudioMs,
    });
    this.markSequence += 1;
    const markName = `rt-${this.markSequence}`;
    this.playbackMarks.set(markName, {
      itemId: this.currentItemId ?? "assistant-current",
      audioEndMs: this.sentItemAudioMs,
    });
    this.socket.send(
      JSON.stringify({
        event: "mark",
        stream_sid: streamSid,
        mark: { name: markName },
      }),
    );
  }

  private clearPlayback(): void {
    if (!this.streamSid) return;
    this.socket.send(
      JSON.stringify({ event: "clear", stream_sid: this.streamSid }),
    );
    this.observer?.onEvent("telephony.playback_cleared", {
      itemId: this.currentItemId,
      playedAudioMs: this.playedItemAudioMs,
    });
    this.media.clearOutput();
    this.playbackMarks.clear();
  }

  private requireStreamSid(): string {
    if (!this.streamSid) throw new Error("Cannot send Exotel audio before start");
    return this.streamSid;
  }

  private isAudioFrame(value: unknown): value is AudioFrame {
    const frame = asRecord(value);
    return (
      frame?.data instanceof Uint8Array &&
      frame.encoding === "pcm16" &&
      frame.sampleRateHz === SAMPLE_RATE_HZ &&
      typeof frame.timestampMs === "number"
    );
  }
}

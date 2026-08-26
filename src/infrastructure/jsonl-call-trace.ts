import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { resolve } from "node:path";

import type { NormalizedEvent } from "../contracts.ts";

export type CallTraceSource = "runtime" | "latency" | "domain" | "summary";

export class JsonlCallTrace {
  readonly path: string;
  private readonly callId: string;
  private readonly stream: WriteStream;
  private sequence = 0;
  private closed = false;
  private failure: Error | undefined;

  constructor(callId: string, directory = "logs") {
    this.callId = callId;
    const absoluteDirectory = resolve(directory);
    mkdirSync(absoluteDirectory, { recursive: true });
    const safeFileStem = callId.replace(/[^a-zA-Z0-9._-]/g, "_") || "call";
    this.path = resolve(absoluteDirectory, `${safeFileStem}.jsonl`);
    this.stream = createWriteStream(this.path, { flags: "a", encoding: "utf8" });
    this.stream.on("error", (error) => {
      this.failure ??= error;
    });
  }

  record(
    source: CallTraceSource,
    type: string,
    payload: Record<string, unknown>,
    occurredAt = new Date().toISOString(),
  ): void {
    if (this.closed) return;
    this.sequence += 1;
    this.stream.write(`${JSON.stringify({
      traceSeq: this.sequence,
      callId: this.callId,
      occurredAt,
      source,
      type,
      payload,
    })}\n`);
  }

  recordDomainEvent(event: NormalizedEvent<unknown>): void {
    this.record("domain", event.type, {
      domainEventId: event.eventId,
      domainSeq: event.seq,
      sourceTurnIds: event.sourceTurnIds,
      data: event.payload,
    }, event.occurredAt);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolveClose, rejectClose) => {
      this.stream.once("finish", resolveClose);
      this.stream.once("error", rejectClose);
      this.stream.end();
    });
    if (this.failure) throw this.failure;
  }
}

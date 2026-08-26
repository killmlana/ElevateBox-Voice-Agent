import type { Clock, NormalizedEvent } from "../contracts.ts";

export type NormalizedEventSink = (
  event: NormalizedEvent<unknown>,
) => void | Promise<void>;

export interface AppendEventInput<T> {
  callId: string;
  type: string;
  payload: T;
  sourceTurnIds?: string[];
}

export class InMemoryEventStore {
  private readonly clock: Clock;
  private readonly sink: NormalizedEventSink | undefined;
  private readonly eventsByCall = new Map<string, NormalizedEvent<unknown>[]>();

  constructor(clock: Clock, sink?: NormalizedEventSink) {
    this.clock = clock;
    this.sink = sink;
  }

  async append<T>(input: AppendEventInput<T>): Promise<NormalizedEvent<T>> {
    const events = this.eventsByCall.get(input.callId) ?? [];
    const seq = events.length + 1;
    const event: NormalizedEvent<T> = {
      eventId: `${input.callId}:${seq}`,
      callId: input.callId,
      seq,
      type: input.type,
      occurredAt: this.clock.now().toISOString(),
      sourceTurnIds: input.sourceTurnIds ?? [],
      payload: input.payload,
    };
    events.push(event as NormalizedEvent<unknown>);
    this.eventsByCall.set(input.callId, events);
    await this.sink?.(event as NormalizedEvent<unknown>);
    return event;
  }

  all(callId: string): NormalizedEvent<unknown>[] {
    return [...(this.eventsByCall.get(callId) ?? [])];
  }
}

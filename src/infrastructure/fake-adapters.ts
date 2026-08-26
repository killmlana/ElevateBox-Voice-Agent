import type {
  CallbackBooking,
  MessagingAdapter,
  OutgoingMessage,
  SchedulerAdapter,
} from "../contracts.ts";

export interface FakeAdapterOptions {
  delayMs?: number;
  failAttempts?: number;
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class FakeMessagingAdapter implements MessagingAdapter {
  readonly deliveries: OutgoingMessage[] = [];
  private readonly delayMs: number;
  private remainingFailures: number;

  constructor(options: FakeAdapterOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.remainingFailures = options.failAttempts ?? 0;
  }

  async send(message: OutgoingMessage): Promise<{ externalId: string }> {
    await delay(this.delayMs);
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("Injected fake messaging failure");
    }
    const existingIndex = this.deliveries.findIndex(
      (delivery) => delivery.idempotencyKey === message.idempotencyKey,
    );
    if (existingIndex >= 0) {
      return { externalId: `wamid.fake.${existingIndex + 1}` };
    }
    this.deliveries.push(message);
    return { externalId: `wamid.fake.${this.deliveries.length}` };
  }
}

export class FakeSchedulerAdapter implements SchedulerAdapter {
  readonly bookings: CallbackBooking[] = [];
  private readonly delayMs: number;
  private remainingFailures: number;

  constructor(options: FakeAdapterOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.remainingFailures = options.failAttempts ?? 0;
  }

  async book(booking: CallbackBooking): Promise<{ externalId: string }> {
    await delay(this.delayMs);
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("Injected fake scheduler failure");
    }
    const existingIndex = this.bookings.findIndex(
      (item) => item.idempotencyKey === booking.idempotencyKey,
    );
    if (existingIndex >= 0) {
      return { externalId: `callback.fake.${existingIndex + 1}` };
    }
    this.bookings.push(booking);
    return { externalId: `callback.fake.${this.bookings.length}` };
  }
}

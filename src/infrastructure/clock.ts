import type { Clock } from "../contracts.ts";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  readonly value: Date;

  constructor(isoTimestamp: string) {
    this.value = new Date(isoTimestamp);
    if (Number.isNaN(this.value.getTime())) {
      throw new Error(`Invalid fixed clock timestamp: ${isoTimestamp}`);
    }
  }

  now(): Date {
    return new Date(this.value);
  }
}

export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;

  enqueue(task: () => Promise<void>): void {
    void this.enqueueAndWait(task).catch(() => undefined);
  }

  enqueueAndWait(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(task);
    this.tail = run.catch((error: unknown) => {
      this.failure ??= error;
    });
    return run;
  }

  async idle(): Promise<void> {
    await this.tail;
    if (this.failure) {
      const error = this.failure;
      this.failure = undefined;
      throw error;
    }
  }
}

import type { ConversationDirective } from "../contracts.ts";

export class ConversationOrchestrator {
  private readonly queues = new Map<string, ConversationDirective[]>();
  private readonly seen = new Set<string>();

  enqueue(directive: ConversationDirective): boolean {
    if (this.seen.has(directive.directiveId)) return false;
    this.seen.add(directive.directiveId);
    const queue = this.queues.get(directive.callId) ?? [];
    queue.push(directive);
    queue.sort((left, right) => left.priority - right.priority);
    this.queues.set(directive.callId, queue);
    return true;
  }

  take(callId: string): ConversationDirective[] {
    const directives = this.queues.get(callId) ?? [];
    this.queues.set(callId, []);
    return directives;
  }

  peek(callId: string): ConversationDirective[] {
    return [...(this.queues.get(callId) ?? [])];
  }
}

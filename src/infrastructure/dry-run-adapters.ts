import type {
  AudioFrame,
  ConversationDirective,
  ConversationRuntime,
  ConversationSessionPort,
  ExtractedLeadUpdate,
  LeadUnderstandingInput,
  LeadUnderstandingPort,
  SessionContext,
  SupportedLanguage,
  VoiceRuntimeEvent,
} from "../contracts.ts";

class DryRunConversationSession implements ConversationSessionPort {
  private closed = false;
  private readonly closedPromise: Promise<void>;
  private closeResolver!: () => void;

  constructor() {
    this.closedPromise = new Promise((resolve) => {
      this.closeResolver = resolve;
    });
  }

  async startConversation(_instruction?: string): Promise<void> {
    this.assertOpen();
  }

  async setPreferredLanguage(_language: SupportedLanguage): Promise<void> {
    this.assertOpen();
  }

  async cancelOutput(): Promise<void> {
    this.assertOpen();
  }

  async sendAudio(_frame: AudioFrame): Promise<void> {
    this.assertOpen();
  }

  async sendDirective(_directive: ConversationDirective): Promise<void> {
    this.assertOpen();
  }

  async interruptOutput(_playedAudioMs: number): Promise<void> {
    this.assertOpen();
  }

  async *events(): AsyncIterable<VoiceRuntimeEvent> {
    await this.closedPromise;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeResolver();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Dry-run conversation is closed");
  }
}

/** No network is touched; createSession resolves READY immediately. */
export class DryRunConversationRuntime implements ConversationRuntime {
  readonly capabilities = {
    bargeIn: true,
    serverVad: true,
    nativeAudio: true,
    languages: ["EN", "HI", "TE", "MIXED"] as const,
  };

  async createSession(_context: SessionContext): Promise<ConversationSessionPort> {
    return new DryRunConversationSession();
  }
}

/** Deterministic empty patch used only when all external AI is disabled. */
export class DryRunLeadUnderstandingAdapter implements LeadUnderstandingPort {
  async understand(_input: LeadUnderstandingInput): Promise<ExtractedLeadUpdate> {
    return {
      locations: [],
      products: [],
      requirements: [],
      blockers: [],
      buyingSignals: [],
      negativeSignals: [],
    };
  }
}

import type { LeadState, OutgoingMessage } from "../contracts.ts";

export interface CandidateContext {
  candidatePhone: string;
  resumeUrl: string;
  architectureUrl: string;
  brochureUrl?: string;
}

function money(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

function contextLines(state: LeadState): string[] {
  const lines: string[] = [];
  if (state.businessDescription) {
    lines.push(`business: ${state.businessDescription.value}`);
  }
  if (state.customerType.value !== "UNKNOWN") {
    lines.push(`customer type: ${state.customerType.value.toLowerCase()}`);
  }
  if (state.locations.length > 0) {
    lines.push(`locations: ${state.locations.map((item) => item.value).join(", ")}`);
  }
  if (state.products.length > 0) {
    lines.push(`products: ${state.products.map((item) => item.value).join(", ")}`);
  }
  if (state.productCount) lines.push(`catalogue: ${state.productCount.value} products`);
  if (state.budgetInr) lines.push(`budget: about ${money(state.budgetInr.value)}`);
  if (state.timeline) lines.push(`timeline: ${state.timeline.value}`);
  if (state.requirements.length > 0) {
    lines.push(
      `requirements: ${state.requirements.map((item) => item.value.text).join(", ")}`,
    );
  }
  return lines;
}

function callbackDisplay(isoTimestamp: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(isoTimestamp));
}

export class MessageComposer {
  private readonly candidate: CandidateContext;
  private readonly leadPhone: string;

  constructor(candidate: CandidateContext, leadPhone: string) {
    this.candidate = candidate;
    this.leadPhone = leadPhone;
  }

  hotDetails(state: LeadState, idempotencyKey: string): OutgoingMessage {
    const details = contextLines(state);
    return {
      to: this.leadPhone,
      body: [
        "Thanks for discussing your e-commerce website with me.",
        details.length > 0 ? `I noted ${details.join("; ")}.` : "I am sharing the project details we discussed.",
        "I’ll keep the next step focused on these requirements.",
        `You can reach me at ${this.candidate.candidatePhone}.`,
      ].join(" "),
      attachments: [this.candidate.resumeUrl, this.candidate.architectureUrl].filter(Boolean),
      idempotencyKey,
    };
  }

  coldBrochure(state: LeadState, idempotencyKey: string): OutgoingMessage {
    const context = state.businessDescription?.value ?? state.products[0]?.value;
    return {
      to: this.leadPhone,
      body: [
        "Here’s a short ElevateBox e-commerce website brochure for whenever it becomes relevant.",
        context ? `I noted your interest around ${context}.` : "There’s no pressure to decide now.",
        `You can reach me at ${this.candidate.candidatePhone}.`,
      ].join(" "),
      attachments: [
        this.candidate.brochureUrl ?? this.candidate.architectureUrl,
      ].filter(Boolean),
      idempotencyKey,
    };
  }

  finalFollowup(state: LeadState, idempotencyKey: string): OutgoingMessage {
    const details = contextLines(state);
    const callback = state.callback.resolvedAt
      ? ` Callback requested for ${callbackDisplay(state.callback.resolvedAt)}.`
      : "";
    return {
      to: this.leadPhone,
      body: [
        "Thank you for the call.",
        details.length > 0
          ? `You’re looking for an e-commerce build with ${details.join("; ")}.`
          : "I’m following up on the e-commerce website discussion.",
        callback,
        `My number is ${this.candidate.candidatePhone}.`,
      ].join(" ").replace(/\s+/g, " ").trim(),
      attachments: [this.candidate.resumeUrl, this.candidate.architectureUrl].filter(Boolean),
      idempotencyKey,
    };
  }
}

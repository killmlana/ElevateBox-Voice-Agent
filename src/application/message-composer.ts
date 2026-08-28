import type { LeadState, OutgoingMessage } from "../contracts.ts";

export interface CandidateContext {
  candidatePhone: string;
  resumeUrl: string;
}

function naturalList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function cleanDetail(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}

function money(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

function projectDetails(state: LeadState): string[] {
  const facts: string[] = [];
  if (state.productCount) {
    facts.push(
      `around ${new Intl.NumberFormat("en-IN").format(state.productCount.value)} products`,
    );
  }
  if (state.budgetInr) facts.push(`a budget of about ${money(state.budgetInr.value)}`);
  if (state.timeline) facts.push(`a ${cleanDetail(state.timeline.value)} timeline`);

  const requirements = state.requirements
    .slice(0, 3)
    .map((item) => cleanDetail(item.value.text))
    .filter(Boolean);
  return [
    ...(facts.length > 0 ? [`You mentioned ${naturalList(facts)}.`] : []),
    ...(requirements.length > 0
      ? [`The main things you need are ${naturalList(requirements)}.`]
      : []),
  ];
}

function conversationTopic(state: LeadState): string {
  if (state.businessDescription) {
    return `the website for your ${cleanDetail(state.businessDescription.value)}`;
  }
  if (state.products.length > 0) {
    const products = state.products
      .slice(0, 2)
      .map((item) => cleanDetail(item.value))
      .filter(Boolean);
    if (products.length > 0) return `your plan to sell ${naturalList(products)} online`;
  }
  if (state.requirements.length > 0) {
    const requirement = cleanDetail(state.requirements[0]!.value.text);
    if (requirement) return `your website and ${requirement}`;
  }
  return "the e-commerce website you are considering";
}

function introduction(phone: string, state: LeadState, briefly = false): string {
  return [
    `Hi, I am Ayanabh. My number is ${phone}.`,
    `We spoke${briefly ? " briefly" : ""} about ${conversationTopic(state)}.`,
  ].join(" ");
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
    return {
      to: this.leadPhone,
      body: [
        introduction(this.candidate.candidatePhone, state),
        ...projectDetails(state),
        "I have attached my resume as discussed.",
        "Message me here if you would like to continue.",
      ].join(" "),
      attachments: [this.candidate.resumeUrl].filter(Boolean),
      idempotencyKey,
      consent: "EXPLICIT_WHATSAPP_OPT_IN",
    };
  }

  coldBrochure(state: LeadState, idempotencyKey: string): OutgoingMessage {
    return {
      to: this.leadPhone,
      body: [
        introduction(this.candidate.candidatePhone, state, true),
        ...projectDetails(state),
        "I have attached my resume as promised.",
        "No rush. Message me if it becomes useful later.",
      ].join(" "),
      attachments: [this.candidate.resumeUrl].filter(Boolean),
      idempotencyKey,
      consent: "EXPLICIT_WHATSAPP_OPT_IN",
    };
  }

  finalFollowup(state: LeadState, idempotencyKey: string): OutgoingMessage {
    const callback = state.callback.resolvedAt
      ? `You asked me to call you back on ${callbackDisplay(state.callback.resolvedAt)}.`
      : undefined;
    return {
      to: this.leadPhone,
      body: [
        introduction(this.candidate.candidatePhone, state),
        ...projectDetails(state),
        callback,
        "I have attached my resume here.",
        "Message me if I missed anything.",
      ].filter(Boolean).join(" "),
      attachments: [this.candidate.resumeUrl].filter(Boolean),
      idempotencyKey,
      ...(state.buyingSignals.some((signal) => signal.value === "send_details")
        ? { consent: "EXPLICIT_WHATSAPP_OPT_IN" as const }
        : {}),
    };
  }
}

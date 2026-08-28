import { createHash } from "node:crypto";

import type { MessagingAdapter, OutgoingMessage } from "../contracts.ts";
import {
  NoopSanitizedLogger,
  safeReference,
  type SanitizedLogger,
} from "./sanitized-logger.ts";

const E164 = /^\+[1-9]\d{7,14}$/;

export interface MetaWhatsAppAdapterConfig {
  dryRun?: boolean;
  allowRealMessages?: boolean;
  accessToken?: string;
  phoneNumberId?: string;
  graphApiVersion?: string;
  templateName?: string;
  templateLanguage?: string;
  allowedRecipient?: string;
  timeoutMs?: number;
  maxIdempotencyEntries?: number;
  logger?: SanitizedLogger;
}

interface RememberedMessage {
  fingerprint: string;
  result: Promise<{ externalId: string; simulated?: boolean }>;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required for live WhatsApp`);
  return value.trim();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function fingerprint(message: OutgoingMessage): string {
  return createHash("sha256").update(JSON.stringify({
    to: message.to,
    body: message.body,
    attachments: message.attachments,
    consent: message.consent ?? null,
  })).digest("hex");
}

/**
 * Sends one approved Meta template with exactly one positional body parameter.
 * Public attachment URLs are appended to that parameter; this deliberately
 * avoids sending follow-up free-form/media messages outside a service window.
 */
export class MetaWhatsAppAdapter implements MessagingAdapter {
  private readonly dryRun: boolean;
  private readonly allowRealMessages: boolean;
  private readonly accessToken: string | undefined;
  private readonly phoneNumberId: string | undefined;
  private readonly graphApiVersion: string;
  private readonly templateName: string | undefined;
  private readonly templateLanguage: string;
  private readonly allowedRecipient: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxIdempotencyEntries: number;
  private readonly logger: SanitizedLogger;
  private readonly fetchFn: typeof fetch;
  private readonly messages = new Map<string, RememberedMessage>();

  constructor(
    config: MetaWhatsAppAdapterConfig = {},
    fetchFn: typeof fetch = fetch,
  ) {
    this.dryRun = config.dryRun ?? true;
    this.allowRealMessages = config.allowRealMessages ?? false;
    this.accessToken = config.accessToken?.trim();
    this.phoneNumberId = config.phoneNumberId?.trim();
    this.graphApiVersion = config.graphApiVersion?.trim() || "v23.0";
    this.templateName = config.templateName?.trim();
    this.templateLanguage = config.templateLanguage?.trim() || "en_US";
    this.allowedRecipient = config.allowedRecipient?.trim();
    this.timeoutMs = config.timeoutMs ?? 8_000;
    this.maxIdempotencyEntries = config.maxIdempotencyEntries ?? 10_000;
    this.logger = config.logger ?? new NoopSanitizedLogger();
    this.fetchFn = fetchFn;

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 500 || this.timeoutMs > 60_000) {
      throw new Error("WhatsApp timeoutMs must be an integer from 500 to 60000");
    }
    if (!Number.isInteger(this.maxIdempotencyEntries) || this.maxIdempotencyEntries < 1) {
      throw new Error("WhatsApp maxIdempotencyEntries must be a positive integer");
    }
    if (this.allowedRecipient !== undefined && !E164.test(this.allowedRecipient)) {
      throw new Error("WhatsApp allowedRecipient must use E.164 format");
    }
    if (!this.dryRun) {
      if (!this.allowRealMessages) {
        throw new Error(
          "Live WhatsApp requires an explicit allowRealMessages acknowledgement",
        );
      }
      required(this.accessToken, "WHATSAPP_ACCESS_TOKEN");
      const phoneNumberId = required(
        this.phoneNumberId,
        "WHATSAPP_PHONE_NUMBER_ID",
      );
      if (!/^\d+$/.test(phoneNumberId)) {
        throw new Error("WHATSAPP_PHONE_NUMBER_ID must contain digits only");
      }
      if (!/^v\d+\.\d+$/.test(this.graphApiVersion)) {
        throw new Error("WHATSAPP_GRAPH_API_VERSION must look like v23.0");
      }
      const templateName = required(
        this.templateName,
        "WHATSAPP_TEMPLATE_NAME",
      );
      if (!/^[a-z0-9_]{1,512}$/.test(templateName)) {
        throw new Error("WHATSAPP_TEMPLATE_NAME is invalid");
      }
      if (!/^[A-Za-z0-9_-]{2,20}$/.test(this.templateLanguage)) {
        throw new Error("WHATSAPP_TEMPLATE_LANGUAGE is invalid");
      }
    }
  }

  send(message: OutgoingMessage): Promise<{
    externalId: string;
    simulated?: boolean;
  }> {
    if (!message.idempotencyKey.trim() || message.idempotencyKey.length > 128) {
      throw new Error("WhatsApp idempotencyKey must contain 1 to 128 characters");
    }
    const requestFingerprint = fingerprint(message);
    const existing = this.messages.get(message.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        return Promise.reject(
          new Error("WhatsApp idempotency key was reused for different content"),
        );
      }
      return existing.result;
    }
    this.validateNewMessage(message);
    if (this.messages.size >= this.maxIdempotencyEntries) {
      throw new Error("WhatsApp idempotency capacity is exhausted");
    }
    const result = this.performSend(message);
    // Keep failures too: a timeout or dropped response may have accepted a
    // real message, so ActionManager retries cannot create duplicates.
    this.messages.set(message.idempotencyKey, {
      fingerprint: requestFingerprint,
      result,
    });
    return result;
  }

  private validateNewMessage(message: OutgoingMessage): void {
    if (!E164.test(message.to)) throw new Error("WhatsApp recipient must use E.164 format");
    if (this.allowedRecipient !== undefined && message.to !== this.allowedRecipient) {
      throw new Error("WhatsApp recipient is not allowed by this deployment");
    }
    if (!message.body.trim()) throw new Error("WhatsApp body must not be empty");
    if (!this.dryRun && message.consent !== "EXPLICIT_WHATSAPP_OPT_IN") {
      throw new Error("Live WhatsApp requires recorded explicit WhatsApp consent");
    }
    if (!this.dryRun) {
      for (const attachment of message.attachments) {
        let url: URL;
        try {
          url = new URL(attachment);
        } catch {
          throw new Error(
            "Live WhatsApp attachments must be public credential-free HTTPS URLs",
          );
        }
        if (url.protocol !== "https:" || url.username || url.password) {
          throw new Error("Live WhatsApp attachments must be public credential-free HTTPS URLs");
        }
      }
    }
    if (this.templateText(message).length > 3_500) {
      throw new Error("WhatsApp template body parameter is too long");
    }
  }

  private templateText(message: OutgoingMessage): string {
    if (message.attachments.length === 0) return message.body.trim();
    return [message.body.trim(), `Links: ${message.attachments.join(" ")}`].join("\n");
  }

  private async performSend(
    message: OutgoingMessage,
  ): Promise<{ externalId: string; simulated?: boolean }> {
    const recipientRef = safeReference(message.to);
    if (this.dryRun) {
      const externalId = `wamid.dryrun.${safeReference(message.idempotencyKey)}`;
      this.logger.info("whatsapp.simulated", {
        recipientRef,
        messageRef: safeReference(externalId),
      });
      return { externalId, simulated: true };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.logger.info("whatsapp.requested", { recipientRef });
    try {
      const response = await this.fetchFn(
        `https://graph.facebook.com/${this.graphApiVersion}/${encodeURIComponent(
          required(this.phoneNumberId, "WHATSAPP_PHONE_NUMBER_ID"),
        )}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${required(
              this.accessToken,
              "WHATSAPP_ACCESS_TOKEN",
            )}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: message.to.slice(1),
            type: "template",
            template: {
              name: required(this.templateName, "WHATSAPP_TEMPLATE_NAME"),
              language: { code: this.templateLanguage },
              components: [{
                type: "body",
                parameters: [{ type: "text", text: this.templateText(message) }],
              }],
            },
          }),
          signal: controller.signal,
        },
      );
      const payload = record(await response.json().catch(() => undefined));
      if (!response.ok) {
        const providerError = record(payload?.error);
        const code = typeof providerError?.code === "number"
          ? providerError.code
          : undefined;
        const subcode = typeof providerError?.error_subcode === "number"
          ? providerError.error_subcode
          : undefined;
        this.logger.warn("whatsapp.rejected", {
          httpStatus: response.status,
          ...(code === undefined ? {} : { providerCode: code }),
          ...(subcode === undefined ? {} : { providerSubcode: subcode }),
          recipientRef,
        });
        throw new Error(
          `Meta WhatsApp request was rejected with HTTP ${response.status}${
            code === undefined ? "" : ` (code ${code})`
          }`,
        );
      }
      const messages = payload?.messages;
      const first = Array.isArray(messages) ? record(messages[0]) : undefined;
      const externalId = first?.id;
      if (typeof externalId !== "string" || !externalId.trim()) {
        throw new Error("Meta WhatsApp response did not contain a message ID");
      }
      this.logger.info("whatsapp.accepted", {
        recipientRef,
        messageRef: safeReference(externalId),
      });
      return { externalId, simulated: false };
    } catch (error) {
      if (controller.signal.aborted) {
        this.logger.error("whatsapp.ambiguous_timeout", { recipientRef });
        throw new Error(
          `Meta WhatsApp timed out after ${this.timeoutMs} ms; it was not retried because acceptance is unknown`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

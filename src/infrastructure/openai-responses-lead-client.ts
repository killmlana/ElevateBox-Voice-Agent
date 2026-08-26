import type { StructuredLeadPatchClient } from "./model-lead-understanding.ts";

export interface OpenAIResponsesLeadClientConfig {
  apiKey: string;
  model: string;
  endpoint?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  maxConcurrency?: number;
  onRequestMetrics?: (metrics: LeadRequestMetrics) => void;
}

export interface LeadRequestMetrics {
  turnId: string;
  model: string;
  status: "completed" | "failed";
  queueMs: number;
  requestMs: number;
  totalMs: number;
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function outputText(response: Record<string, unknown>): string {
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) {
    throw new Error("OpenAI Responses result did not contain model output");
  }

  for (const rawItem of response.output) {
    const item = asRecord(rawItem);
    if (!item || !Array.isArray(item.content)) continue;
    for (const rawContent of item.content) {
      const content = asRecord(rawContent);
      if (!content) continue;
      if (content.type === "refusal") {
        throw new Error("Lead understanding model refused the request");
      }
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  throw new Error("OpenAI Responses result contained no structured text output");
}

export class OpenAIResponsesLeadPatchClient
  implements StructuredLeadPatchClient
{
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly maxConcurrency: number;
  private readonly onRequestMetrics: ((metrics: LeadRequestMetrics) => void) | undefined;
  private readonly fetchFn: typeof fetch;
  private activeRequests = 0;
  private readonly requestWaiters: Array<() => void> = [];

  constructor(
    config: OpenAIResponsesLeadClientConfig,
    fetchFn: typeof fetch = fetch,
  ) {
    if (!config.apiKey.trim()) throw new Error("OpenAI API key is required");
    if (!config.model.trim()) throw new Error("Lead understanding model is required");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.endpoint = config.endpoint ?? "https://api.openai.com/v1/responses";
    this.timeoutMs = config.timeoutMs ?? 8_000;
    this.maxOutputTokens = config.maxOutputTokens ?? 800;
    this.maxConcurrency = config.maxConcurrency ?? 4;
    if (!Number.isInteger(this.maxConcurrency) || this.maxConcurrency < 1) {
      throw new Error("Lead understanding concurrency must be a positive integer");
    }
    this.onRequestMetrics = config.onRequestMetrics;
    this.fetchFn = fetchFn;
  }

  async generate(
    input: Parameters<StructuredLeadPatchClient["generate"]>[0],
  ): Promise<unknown> {
    const totalStartedAt = performance.now();
    const release = await this.acquireRequestSlot();
    const requestStartedAt = performance.now();
    const queueMs = requestStartedAt - totalStartedAt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let requestId: string | undefined;
    let status: LeadRequestMetrics["status"] = "failed";
    let usage: Record<string, unknown> | undefined;
    let metricsError: string | undefined;
    try {
      const response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          store: false,
          max_output_tokens: this.maxOutputTokens,
          instructions: input.instruction,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: JSON.stringify({
                    precedingAssistantText: input.precedingAssistantText ?? null,
                    latestStableTurn: input.turnText,
                    languageHint: input.languageHint ?? null,
                  }),
                },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: input.schemaName,
              strict: true,
              schema: input.schema,
            },
          },
        }),
        signal: controller.signal,
      });
      requestId = response.headers.get("x-request-id") ?? undefined;
      if (!response.ok) {
        let providerCode = "";
        try {
          const failure = asRecord(await response.json());
          const providerError = asRecord(failure?.error);
          const type = typeof providerError?.type === "string"
            ? providerError.type
            : undefined;
          const code = typeof providerError?.code === "string"
            ? providerError.code
            : undefined;
          const param = typeof providerError?.param === "string"
            ? providerError.param
            : undefined;
          providerCode = [type, code, param].filter(Boolean).join("/");
        } catch {
          // Keep provider response bodies out of application errors.
        }
        throw new Error(
          `OpenAI Responses request failed with ${response.status}${
            providerCode ? ` (${providerCode})` : ""
          }${
            requestId ? ` (request ${requestId})` : ""
          }`,
        );
      }
      const rawResponse = (await response.json()) as unknown;
      const responseObject = asRecord(rawResponse);
      if (!responseObject) throw new Error("OpenAI Responses result was not an object");
      usage = asRecord(responseObject.usage);
      if (responseObject.status === "incomplete") {
        const details = asRecord(responseObject.incomplete_details);
        const reason = typeof details?.reason === "string"
          ? details.reason
          : undefined;
        throw new Error(
          `OpenAI Responses lead extraction was incomplete${
            reason ? `: ${reason}` : ""
          }`,
        );
      }
      const result = JSON.parse(outputText(responseObject)) as unknown;
      status = "completed";
      return result;
    } catch (error) {
      const reported = controller.signal.aborted
        ? new Error(`OpenAI Responses lead extraction timed out after ${this.timeoutMs} ms`)
        : error;
      metricsError = reported instanceof Error ? reported.message : String(reported);
      throw reported;
    } finally {
      clearTimeout(timer);
      release();
      const inputTokens = numberValue(usage?.input_tokens);
      const outputTokens = numberValue(usage?.output_tokens);
      const totalTokens = numberValue(usage?.total_tokens);
      const outputDetails = asRecord(usage?.output_tokens_details);
      const reasoningTokens = numberValue(outputDetails?.reasoning_tokens);
      try {
        this.onRequestMetrics?.({
          turnId: input.turnId,
          model: this.model,
          status,
          queueMs,
          requestMs: performance.now() - requestStartedAt,
          totalMs: performance.now() - totalStartedAt,
          ...(requestId === undefined ? {} : { requestId }),
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
          ...(totalTokens === undefined ? {} : { totalTokens }),
          ...(metricsError === undefined ? {} : { error: metricsError }),
        });
      } catch {
        // Metrics must never affect lead extraction.
      }
    }
  }

  private async acquireRequestSlot(): Promise<() => void> {
    if (this.activeRequests < this.maxConcurrency) {
      this.activeRequests += 1;
      return () => this.releaseRequestSlot();
    }
    await new Promise<void>((resolve) => this.requestWaiters.push(resolve));
    return () => this.releaseRequestSlot();
  }

  private releaseRequestSlot(): void {
    const next = this.requestWaiters.shift();
    if (next) {
      next();
      return;
    }
    this.activeRequests -= 1;
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

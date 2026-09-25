import { readAiApiKey, readAiBaseUrl, readAiModel } from "@/lib/ai/config";
import type { AiProvider, AiProviderRequest, AiProviderResult } from "@/lib/ai/types";

/**
 * OpenAI-compatible Chat Completions adapter. No SDK dependency.
 * Never called unless an API key is actually configured.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly id = "openai";
  readonly connected = true;

  async complete(request: AiProviderRequest): Promise<AiProviderResult> {
    const started = Date.now();
    const key = readAiApiKey();
    const model = readAiModel();
    if (!key) {
      return {
        ok: false,
        provider: this.id,
        model,
        error: "AI is not connected.",
        retryable: false,
        latencyMs: 0,
      };
    }

    try {
      const response = await fetch(`${readAiBaseUrl().replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: request.maxOutputTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
        }),
      });
      const latencyMs = Date.now() - started;
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (!response.ok) {
        return {
          ok: false,
          provider: this.id,
          model,
          error: body.error?.message || `AI provider returned ${response.status}.`,
          retryable: response.status >= 500 || response.status === 429,
          latencyMs,
        };
      }
      const text = body.choices?.[0]?.message?.content?.trim() || "";
      if (!text) {
        return {
          ok: false,
          provider: this.id,
          model,
          error: "The AI provider returned an empty response.",
          retryable: true,
          latencyMs,
        };
      }
      return {
        ok: true,
        provider: this.id,
        model,
        text,
        usage: {
          promptTokens: body.usage?.prompt_tokens,
          completionTokens: body.usage?.completion_tokens,
        },
        latencyMs,
      };
    } catch (error) {
      return {
        ok: false,
        provider: this.id,
        model,
        error: error instanceof Error ? error.message : "The AI provider could not be reached.",
        retryable: true,
        latencyMs: Date.now() - started,
      };
    }
  }
}

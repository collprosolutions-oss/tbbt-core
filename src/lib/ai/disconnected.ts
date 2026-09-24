import { AI_NOT_CONNECTED_MESSAGE, type AiProvider, type AiProviderRequest, type AiProviderResult } from "@/lib/ai/types";

export class DisconnectedAiProvider implements AiProvider {
  readonly id = "none";
  readonly connected = false;

  async complete(_request: AiProviderRequest): Promise<AiProviderResult> {
    return {
      ok: false,
      provider: this.id,
      error: AI_NOT_CONNECTED_MESSAGE,
      retryable: false,
      latencyMs: 0,
    };
  }
}

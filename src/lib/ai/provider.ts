import { isAiProviderConnected } from "@/lib/ai/config";
import { DisconnectedAiProvider } from "@/lib/ai/disconnected";
import { OpenAiCompatibleProvider } from "@/lib/ai/openai-compatible";
import type { AiProvider } from "@/lib/ai/types";

export function resolveAiProvider(): AiProvider {
  if (!isAiProviderConnected()) {
    return new DisconnectedAiProvider();
  }
  return new OpenAiCompatibleProvider();
}

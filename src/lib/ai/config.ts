/**
 * AI connection is real credentials only. An env provider *name* never
 * means a model is connected.
 */

export function readAiApiKey() {
  return (
    process.env.TBBT_AI_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    ""
  );
}

export function readAiBaseUrl() {
  return (
    process.env.TBBT_AI_BASE_URL?.trim() ||
    "https://api.openai.com/v1"
  );
}

export function readAiModel() {
  return process.env.TBBT_AI_MODEL?.trim() || "gpt-4o-mini";
}

export function isAiProviderConnected() {
  return Boolean(readAiApiKey());
}

export function aiConnectionLabel() {
  return isAiProviderConnected()
    ? `Connected (${readAiModel()})`
    : "Not Connected";
}

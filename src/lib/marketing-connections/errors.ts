const TOKEN_PATTERNS = [
  /EAA[A-Za-z0-9]+/g,
  /ya29\.[A-Za-z0-9_\-]+/g,
  /access_token=[^&\s]+/gi,
  /refresh_token=[^&\s]+/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
];

export class MarketingConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketingConnectionError";
  }
}

export function sanitizeConnectionError(raw: string | null | undefined, secrets: readonly string[] = []) {
  let text = (raw ?? "").replace(/\s+/g, " ").trim();
  const hidden = [...secrets].filter((secret) => secret.trim().length >= 4).sort((a, b) => b.length - a.length);
  for (const secret of hidden) {
    text = text.split(secret).join("[redacted]");
    const encoded = encodeURIComponent(secret);
    if (encoded && encoded !== secret) text = text.split(encoded).join("[redacted]");
  }
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, "[redacted]");
  }
  if (text.length > 200) text = text.slice(0, 200);
  return text;
}

export function connectionErrorMessage(error: unknown, fallback: string) {
  if (error instanceof MarketingConnectionError) return error.message;
  return fallback;
}

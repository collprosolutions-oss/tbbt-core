/**
 * Strip secrets and unnecessary raw customer data before anything is
 * sent to a model or stored on an AiInteraction.
 */

const SECRET_KEY_PATTERN =
  /(password|token|secret|authorization|cookie|ssn|cardNumber|cvv|totp|backupCode|api[_-]?key|private[_-]?key)/i;

const SECRET_VALUE_PATTERN =
  /(sk_live_|sk_test_|whsec_|Bearer\s+[A-Za-z0-9._-]+|BLOB_READ_WRITE_TOKEN)/i;

export function sanitizeAiText(value: string, max = 8_000) {
  const stripped = value
    .replace(SECRET_VALUE_PATTERN, "[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, "[phone]")
    .trim();
  return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
}

export function sanitizeAiContext(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") return sanitizeAiText(value, 1_200);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => sanitizeAiContext(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = sanitizeAiContext(nested, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function summarizeAiInput(taskType: string, text: string) {
  return sanitizeAiText(`${taskType}: ${text}`, 400);
}

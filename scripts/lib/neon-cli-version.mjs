/**
 * Neon CLI version gate for hosted PITR / private R2 recovery.
 *
 * `--no-secrets` on neon branches create needs CLI 4.9.0+.
 * An older or missing binary must fail closed before any
 * `neon branches` restore or verify command.
 */

export const MIN_NEON_CLI_VERSION = "4.9.0";

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/;

export function parseNeonCliVersion(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const match = raw.match(SEMVER_RE);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].slice(1) : "",
    text: `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ""}`,
  };
}

function compareParsed(left, right) {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (!left.prerelease && !right.prerelease) return 0;
  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && right.prerelease) return 1;
  return left.prerelease < right.prerelease ? -1 : left.prerelease > right.prerelease ? 1 : 0;
}

export function evaluateNeonCliVersion(text, minimum = MIN_NEON_CLI_VERSION) {
  const raw = text == null ? "" : String(text);
  if (!raw.trim()) {
    return {
      ok: false,
      version: null,
      reason: `Neon CLI is missing. Upgrade to ${minimum} or newer (needed for --no-secrets), then retry. Stop otherwise.`,
    };
  }
  const parsed = parseNeonCliVersion(raw);
  const min = parseNeonCliVersion(minimum);
  if (!parsed || !min) {
    return {
      ok: false,
      version: parsed?.text ?? null,
      reason: `Neon CLI version output was unreadable (${JSON.stringify(raw.slice(0, 80))}). Upgrade to ${minimum} or newer (needed for --no-secrets), then retry. Stop otherwise.`,
    };
  }
  if (compareParsed(parsed, min) < 0) {
    return {
      ok: false,
      version: parsed.text,
      reason: `Neon CLI ${parsed.text} is older than required ${minimum} (needed for --no-secrets). Upgrade first, then retry. Stop otherwise.`,
    };
  }
  return {
    ok: true,
    version: parsed.text,
    reason: `Neon CLI ${parsed.text} meets required ${minimum}.`,
  };
}

export function neonCliVersionGuardMessage(decision) {
  return decision.reason;
}

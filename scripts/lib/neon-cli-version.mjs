/**
 * Neon CLI version gate for hosted PITR / private R2 recovery.
 *
 * `--no-secrets` on neon branches create needs CLI 4.9.0+.
 * An older, missing, or unreadable binary must fail closed before any
 * `neon branches` restore or verify command.
 *
 * Parse ONLY a single anchored stdout line. Do not scan stderr or hunt
 * for the first x.y.z anywhere in mixed output.
 */

export const MIN_NEON_CLI_VERSION = "4.9.0";

export const NEON_CLI_VERSION_LINE_RE =
  /^(?:neon(?:ctl)?\s+)?v?(\d+)\.(\d+)\.(\d+)(?:([-+])([0-9A-Za-z.-]+))?$/;

const MIN_PARSED = Object.freeze({
  major: 4,
  minor: 9,
  patch: 0,
  prerelease: "",
});

export function meaningfulLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseNeonCliVersion(text) {
  const lines = meaningfulLines(text);
  if (lines.length !== 1) return null;
  const match = lines[0].match(NEON_CLI_VERSION_LINE_RE);
  if (!match) return null;
  const prerelease = match[4] === "-" ? match[5] : "";
  const build = match[4] === "+" ? match[5] : "";
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    text: `${match[1]}.${match[2]}.${match[3]}${prerelease ? `-${prerelease}` : ""}${
      build ? `+${build}` : ""
    }`,
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

function refuse(reason, version = null) {
  return { ok: false, version, reason };
}

function upgradeFirst(detail, minimum = MIN_NEON_CLI_VERSION) {
  return `${detail} Upgrade first to ${minimum} or newer (needed for --no-secrets), then retry. Stop otherwise.`;
}

export function evaluateNeonCliVersion(text, minimum = MIN_NEON_CLI_VERSION) {
  const raw = text == null ? "" : String(text);
  if (!raw.trim()) {
    return refuse(upgradeFirst("Neon CLI is missing."));
  }
  const lines = meaningfulLines(raw);
  if (lines.length !== 1) {
    return refuse(
      upgradeFirst(
        `Neon CLI version output was unreadable (${JSON.stringify(raw.slice(0, 80))}).`,
      ),
    );
  }
  const parsed = parseNeonCliVersion(raw);
  const min = parseNeonCliVersion(minimum) ?? MIN_PARSED;
  if (!parsed) {
    return refuse(
      upgradeFirst(
        `Neon CLI version output was unreadable (${JSON.stringify(raw.slice(0, 80))}).`,
      ),
    );
  }
  const belowFloor = compareParsed(parsed, min) < 0;
  const prereleaseOfFloor =
    parsed.major === min.major &&
    parsed.minor === min.minor &&
    parsed.patch === min.patch &&
    Boolean(parsed.prerelease);
  if (belowFloor || prereleaseOfFloor) {
    return refuse(
      `Neon CLI ${parsed.text} is older than required ${minimum} (needed for --no-secrets). Upgrade first, then retry. Stop otherwise.`,
      parsed.text,
    );
  }
  return {
    ok: true,
    version: parsed.text,
    reason: `Neon CLI ${parsed.text} meets required ${minimum}.`,
  };
}

export function evaluateNeonCliVersionProcess(result = {}, minimum = MIN_NEON_CLI_VERSION) {
  if (result.error) {
    if (result.error.code === "ENOENT") {
      return evaluateNeonCliVersion("", minimum);
    }
    return refuse(
      upgradeFirst(
        `Neon CLI could not be started (${result.error.code ?? result.error.message}).`,
      ),
    );
  }
  if (result.status !== 0) {
    return refuse(
      upgradeFirst(`neon --version exited ${result.status ?? "non-zero"}.`),
    );
  }
  return evaluateNeonCliVersion(result.stdout ?? "", minimum);
}

export function neonCliVersionGuardMessage(decision) {
  return decision.reason;
}

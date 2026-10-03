/**
 * Operator / CI gate: Neon CLI must be 4.9.0+ before any hosted
 * `neon branches` restore or verify command.
 *
 * Fail-closed on a missing binary, unreadable output, or older version.
 * Set NEON_CLI_VERSION_TEXT to inject `neon --version` text in tests
 * (does not spawn neon).
 *
 *   node scripts/require-neon-cli.mjs
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateNeonCliVersion,
  neonCliVersionGuardMessage,
} from "./lib/neon-cli-version.mjs";

export function readNeonCliVersionText({
  env = process.env,
  spawn = spawnSync,
} = {}) {
  if (Object.prototype.hasOwnProperty.call(env, "NEON_CLI_VERSION_TEXT")) {
    return { text: env.NEON_CLI_VERSION_TEXT ?? "", source: "env" };
  }
  const result = spawn("neon", ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      return { text: "", source: "missing-binary" };
    }
    return { text: result.error.message ?? "", source: "spawn-error" };
  }
  return {
    text: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    source: "neon --version",
    status: result.status,
  };
}

export function assertNeonCliVersion(text) {
  const decision = evaluateNeonCliVersion(text);
  if (!decision.ok) {
    const error = new Error(neonCliVersionGuardMessage(decision));
    error.name = "NeonCliVersionRefusedError";
    throw error;
  }
  return decision;
}

function main() {
  const read = readNeonCliVersionText();
  const decision = evaluateNeonCliVersion(read.text);
  if (!decision.ok) {
    console.error(neonCliVersionGuardMessage(decision));
    process.exit(1);
  }
  console.log(neonCliVersionGuardMessage(decision));
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main();
}

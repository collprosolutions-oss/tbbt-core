/**
 * Operator / CI gate: Neon CLI must be 4.9.0+ before any hosted
 * `neon branches` restore or verify command.
 *
 * Fail-closed on a missing binary, non-zero `neon --version`,
 * unreadable stdout, or an older / 4.9.0-prerelease version.
 * Parses stdout only. Stderr is ignored. There is no env override
 * that skips the live binary.
 *
 *   node scripts/require-neon-cli.mjs
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateNeonCliVersionProcess,
  neonCliVersionGuardMessage,
} from "./lib/neon-cli-version.mjs";

export function readNeonCliVersionProcess({
  spawn = spawnSync,
  env = process.env,
} = {}) {
  const result = spawn("neon", ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    env,
  });
  return {
    error: result.error ?? null,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function assertNeonCliVersionProcess(processResult) {
  const decision = evaluateNeonCliVersionProcess(processResult);
  if (!decision.ok) {
    const error = new Error(neonCliVersionGuardMessage(decision));
    error.name = "NeonCliVersionRefusedError";
    throw error;
  }
  return decision;
}

function main() {
  const processResult = readNeonCliVersionProcess();
  const decision = evaluateNeonCliVersionProcess(processResult);
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

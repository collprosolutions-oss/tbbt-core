/**
 * Static and shimmed checks for the hosted Neon PITR runbook bash blocks.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRE_NEON_GUARD =
  "node scripts/require-neon-cli.mjs || return 1 2>/dev/null || exit 1";

const VERIFY_ASSIGN_RE = /^\s*VERIFY_NAME=(.*)$/m;
const VERIFY_EMPTY_ASSIGN_RE = /^\s*VERIFY_NAME=(?:""|'')?\s*$/m;
const CREATE_RE = /^\s*neon branches create\b/m;
const GET_RE = /^\s*neon branches get\b/m;
const VERIFY_CONN_RE = /^\s*neon connection-string "\$VERIFY_NAME"/m;

const REQUIRED_CHECKS = [
  '[ -n "$PROJECT" ] || { echo \'PROJECT must be set\' >&2; return 1 2>/dev/null || exit 1; }',
  '[ -n "$ROOT_BRANCH" ] || { echo \'ROOT_BRANCH must be the project default root\' >&2; return 1 2>/dev/null || exit 1; }',
  '[ -n "$DEFAULT_BRANCH" ] || { echo \'DEFAULT_BRANCH must be the project default\' >&2; return 1 2>/dev/null || exit 1; }',
  '[ -n "$T" ] || { echo \'T must be the incident timestamp\' >&2; return 1 2>/dev/null || exit 1; }',
  '[ -n "$VERIFY_NAME" ] || { echo \'VERIFY_NAME must be the isolated verify branch\' >&2; return 1 2>/dev/null || exit 1; }',
  '[ "$VERIFY_NAME" != "$ROOT_BRANCH" ] || { echo \'VERIFY_NAME must not equal ROOT_BRANCH\' >&2; return 1 2>/dev/null || exit 1; }',
  '[ "$VERIFY_NAME" != "$DEFAULT_BRANCH" ] || { echo \'VERIFY_NAME must not equal the default branch\' >&2; return 1 2>/dev/null || exit 1; }',
];

export function extractFencedBashBlocks(markdown) {
  return [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
}

function uncommentedLines(block) {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function lineCallsNeon(line) {
  return /(?:^|[;&|]\s*)neon\s/.test(line) || /\$\(\s*neon\s/.test(line);
}

export function hostedRecoveryVerifyNameSafety(markdown) {
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*:[?][^}]*['"]/.test(markdown)) return false;
  if (/:[ \t]*"\$\{[^}]*[''][^}]*\}"/.test(markdown)) return false;

  const assignMatch = markdown.match(VERIFY_ASSIGN_RE);
  if (!assignMatch) return false;
  if (VERIFY_EMPTY_ASSIGN_RE.test(assignMatch[0])) return false;
  const value = assignMatch[1].trim();
  if (value === '""' || value === "''" || value === "") return false;

  const assignIdx = markdown.search(VERIFY_ASSIGN_RE);
  const createIdx = markdown.search(CREATE_RE);
  const getIdx = markdown.search(GET_RE);
  const connIdx = markdown.search(VERIFY_CONN_RE);
  if (assignIdx === -1 || createIdx === -1 || getIdx === -1 || connIdx === -1) {
    return false;
  }
  if (!(assignIdx < createIdx && assignIdx < getIdx && assignIdx < connIdx)) {
    return false;
  }

  for (const check of REQUIRED_CHECKS) {
    if (!markdown.includes(check)) return false;
  }

  const neonBlocks = extractFencedBashBlocks(markdown).filter((block) =>
    uncommentedLines(block).some(lineCallsNeon),
  );
  for (const block of neonBlocks) {
    const lines = uncommentedLines(block);
    const usesProject = lines.some((line) => line.includes("$PROJECT") && lineCallsNeon(line));
    const usesVerify = lines.some(
      (line) => lineCallsNeon(line) && /\$VERIFY_NAME/.test(line),
    );
    if (usesProject && !block.includes('[ -n "$PROJECT" ]')) return false;
    if (usesVerify) {
      if (!block.includes('[ -n "$VERIFY_NAME" ]')) return false;
      if (!block.includes('[ "$VERIFY_NAME" != "$ROOT_BRANCH" ]')) return false;
      if (!block.includes('[ "$VERIFY_NAME" != "$DEFAULT_BRANCH" ]')) return false;
    }
  }
  return true;
}

export function bashSyntaxResults(markdown) {
  return extractFencedBashBlocks(markdown).map((block, index) => {
    const result = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: block,
    });
    return {
      index,
      ok: result.status === 0,
      stderr: result.stderr,
      block,
    };
  });
}

function writeLoggingTools(dir) {
  const logPath = path.join(dir, "calls.log");
  const tool = (name) => `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const logPath = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify({ tool: ${JSON.stringify(name)}, args }) + "\\n");
if (${JSON.stringify(name)} === "neon" && args[0] === "--version") {
  process.stdout.write("4.9.0\\n");
  process.exit(0);
}
if (${JSON.stringify(name)} === "neon" && args[0] === "projects") {
  process.stdout.write(JSON.stringify({ project: { history_retention_seconds: 21600 } }) + "\\n");
  process.exit(0);
}
if (${JSON.stringify(name)} === "neon" && args[0] === "branches" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ name: "main", default: true }]) + "\\n");
  process.exit(0);
}
if (${JSON.stringify(name)} === "neon" && args[0] === "branches" && args[1] === "get") {
  process.stdout.write(JSON.stringify({
    id: "br-verify",
    name: args[2] || "",
    parent_id: "br-main",
    parent_timestamp: process.env.T || "",
    parent_lsn: "0/0",
    default: false,
  }) + "\\n");
  process.exit(0);
}
if (${JSON.stringify(name)} === "neon" && args[0] === "connection-string" && args.includes("--psql")) {
  const psql = spawnSync("psql", ["--fake-from-neon"], { encoding: "utf8", env: process.env });
  process.exit(psql.status ?? 0);
}
process.exit(0);
`;
  writeFileSync(path.join(dir, "neon"), tool("neon"), { mode: 0o755 });
  writeFileSync(path.join(dir, "psql"), tool("psql"), { mode: 0o755 });
  writeFileSync(path.join(dir, "aws"), tool("aws"), { mode: 0o755 });
  return logPath;
}

function readCallLog(logPath) {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function toolEnv(dir, extra = {}) {
  const env = { ...process.env, ...extra, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
  delete env.NEON_CLI_VERSION_TEXT;
  delete env.VERCEL;
  delete env.VERCEL_ENV;
  delete env.VERCEL_PROJECT_ID;
  delete env.VERCEL_PROJECT_NAME;
  delete env.VERCEL_PROJECT_PRODUCTION_URL;
  delete env.VERCEL_URL;
  return env;
}

function neonBranchArgs(calls) {
  const empty = [];
  for (const call of calls) {
    if (call.tool !== "neon") continue;
    const [cmd, sub, ...rest] = call.args;
    if (cmd === "--version") continue;
    if (cmd === "connection-string") {
      if (!sub || sub.startsWith("-")) empty.push(call);
      continue;
    }
    if (cmd === "branches" && sub === "get") {
      if (!rest[0] || rest[0].startsWith("-")) empty.push(call);
      continue;
    }
    if (cmd === "branches" && sub === "create") {
      const nameIdx = call.args.indexOf("--name");
      if (nameIdx === -1 || !call.args[nameIdx + 1]) empty.push(call);
      continue;
    }
    if (cmd === "branches" && sub === "restore") {
      if (!rest[0] || rest[0].startsWith("-")) empty.push(call);
    }
    if (cmd === "projects" && sub === "get") {
      if (!rest[0] || rest[0].startsWith("-")) empty.push(call);
    }
    if (call.args.includes("--project-id")) {
      const idx = call.args.indexOf("--project-id");
      if (!call.args[idx + 1]) empty.push(call);
    }
  }
  return empty;
}

export function runSection42Flow(markdown, { cwd } = {}) {
  const blocks = extractFencedBashBlocks(markdown);
  const neonBlocks = blocks.filter((block) => uncommentedLines(block).some(lineCallsNeon));
  const section42 = neonBlocks.filter(
    (block) =>
      !uncommentedLines(block).some((line) => line.startsWith("neon branches restore")) &&
      !uncommentedLines(block).some((line) => line.startsWith("aws ")),
  );
  const forbidden = blocks.find((block) =>
    uncommentedLines(block).some((line) => line.includes("Forbidden until a recorded GO")),
  );
  const dir = mkdtempSync(path.join(tmpdir(), "tbbt-hosted-recovery-flow-"));
  const logPath = writeLoggingTools(dir);
  const env = toolEnv(dir, {
    PROJECT: "prj_test_empty_cherry",
    T: "2026-10-03T00:00:00Z",
  });
  const workCwd = cwd ?? fileURLToPath(new URL("../..", import.meta.url));
  const flow = section42.join("\n");
  const flowResult = spawnSync("bash", ["-s"], {
    encoding: "utf8",
    cwd: workCwd,
    env,
    input: flow,
  });
  const flowCalls = readCallLog(logPath);
  writeFileSync(logPath, "");
  const forbiddenResult = spawnSync("bash", ["-s"], {
    encoding: "utf8",
    cwd: workCwd,
    env: toolEnv(dir, {
      PROJECT: "prj_test_empty_cherry",
      ROOT_BRANCH: "main",
      T: "2026-10-03T00:00:00Z",
    }),
    input: forbidden,
  });
  const forbiddenCalls = readCallLog(logPath);
  rmSync(dir, { recursive: true, force: true });

  const neonCmds = flowCalls
    .filter((call) => call.tool === "neon")
    .map((call) => call.args.join(" "));
  const createIdx = neonCmds.findIndex((line) => line.startsWith("branches create"));
  const getIdx = neonCmds.findIndex((line) => line.startsWith("branches get"));
  const verifyConnIdx = neonCmds.findIndex((line) =>
    /^connection-string tbbt-pitr-verify-/.test(line),
  );
  const verifyNameOnCreate = (() => {
    const create = flowCalls.find(
      (call) => call.tool === "neon" && call.args[0] === "branches" && call.args[1] === "create",
    );
    if (!create) return "";
    const nameIdx = create.args.indexOf("--name");
    return create.args[nameIdx + 1] ?? "";
  })();

  return {
    flowStatus: flowResult.status,
    flowStderr: flowResult.stderr,
    flowCalls,
    neonCmds,
    emptyBranchArgs: neonBranchArgs(flowCalls),
    verifyNameOnCreate,
    verifyNameBeforeGetAndConn:
      verifyNameOnCreate.startsWith("tbbt-pitr-verify-") &&
      createIdx !== -1 &&
      getIdx > createIdx &&
      verifyConnIdx > createIdx &&
      neonCmds[getIdx].includes(verifyNameOnCreate) &&
      neonCmds[verifyConnIdx].includes(verifyNameOnCreate),
    expectedSequence:
      neonCmds.includes("--version") &&
      neonCmds.some((line) => line.startsWith("projects get")) &&
      neonCmds.some((line) => line.startsWith("branches list")) &&
      neonCmds.some((line) => line.startsWith("connection-string main@")) &&
      neonCmds.some((line) => line.startsWith("branches create")) &&
      neonCmds.some((line) => line.startsWith("branches get")) &&
      neonCmds.some((line) => /^connection-string tbbt-pitr-verify-/.test(line)) &&
      flowCalls.some((call) => call.tool === "psql"),
    forbiddenStatus: forbiddenResult.status,
    forbiddenCalls,
    forbiddenRanRestore: forbiddenCalls.some(
      (call) => call.tool === "neon" && call.args[0] === "branches" && call.args[1] === "restore",
    ),
  };
}

export function runInteractiveEmptyVarCases(markdown, { cwd } = {}) {
  const blocks = extractFencedBashBlocks(markdown);
  const getBlock = blocks.find((block) =>
    uncommentedLines(block).some((line) => line.startsWith("neon branches get")),
  );
  const connBlock = blocks.find((block) =>
    uncommentedLines(block).some((line) =>
      line.startsWith('neon connection-string "$VERIFY_NAME"'),
    ),
  );
  const workCwd = cwd ?? fileURLToPath(new URL("../..", import.meta.url));
  const cases = [
    { label: "block4 VERIFY_NAME unset paste", block: getBlock, unset: ["VERIFY_NAME"] },
    { label: "block4 VERIFY_NAME empty paste", block: getBlock, empty: ["VERIFY_NAME"] },
    { label: "block5 VERIFY_NAME unset paste", block: connBlock, unset: ["VERIFY_NAME"] },
    { label: "block5 PROJECT unset paste", block: connBlock, unset: ["PROJECT"] },
    { label: "block4 PROJECT empty paste", block: getBlock, empty: ["PROJECT"] },
  ];

  const results = [];
  for (const spec of cases) {
    for (const mode of ["paste", "source"]) {
      const dir = mkdtempSync(path.join(tmpdir(), "tbbt-hosted-recovery-i-"));
      const logPath = writeLoggingTools(dir);
      const env = toolEnv(dir, {
        PROJECT: "prj_test_empty_cherry",
        ROOT_BRANCH: "main",
        DEFAULT_BRANCH: "main",
        T: "2026-10-03T00:00:00Z",
        VERIFY_NAME: "tbbt-pitr-verify-keep",
        HOME: dir,
        PS1: "",
      });
      for (const name of spec.unset ?? []) delete env[name];
      for (const name of spec.empty ?? []) env[name] = "";
      let result;
      if (mode === "paste") {
        result = spawnSync("bash", ["-i"], {
          encoding: "utf8",
          cwd: workCwd,
          env,
          input: `${spec.block}\n`,
        });
      } else {
        const file = path.join(dir, "block.sh");
        writeFileSync(file, spec.block);
        result = spawnSync("bash", ["-i", "-c", `source '${file}'`], {
          encoding: "utf8",
          cwd: workCwd,
          env,
        });
      }
      const calls = readCallLog(logPath);
      const neonBeyondVersion = calls.filter(
        (call) => call.tool === "neon" && call.args[0] !== "--version",
      );
      rmSync(dir, { recursive: true, force: true });
      results.push({
        label: `${spec.label} ${mode}`,
        status: result.status,
        neonBeyondVersion,
        calls,
      });
    }
  }
  return results;
}

export { REQUIRED_CHECKS };

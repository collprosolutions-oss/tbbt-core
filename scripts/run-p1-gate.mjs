/**
 * Run one P1 regression-gate domain.
 *
 *   node scripts/run-p1-gate.mjs <domain> [--fail-fast] [--allow-missing]
 *   node scripts/run-p1-gate.mjs <domain> --audit [--strict] [--allow-missing]
 *
 * Before any child process, a domain that includes a DB-backed script
 * requires DATABASE_URL to parse as a URL whose host is exactly
 * localhost, 127.0.0.1, or ::1. Query parameters host, hostaddr, and
 * service are refused (any case), as is a comma in the host, because
 * libpq and Prisma honor those over the authority. DIRECT_URL,
 * POSTGRES_URL, POSTGRES_PRISMA_URL, PGHOST, PGHOSTADDR, and PGSERVICE
 * are removed from the child environment; a non-local value refuses
 * the run before any child starts.
 *
 * Children run serially. package.json decides plain `node` versus
 * `node --experimental-strip-types`. TZ=America/New_York is forced.
 * Each child has a timeout. SIGINT and SIGTERM are forwarded to the
 * running child. This process never runs `npm run build` or `next build`.
 *
 * --audit is static: no database connection and no child scripts.
 * Findings on existing scripts are warnings. --strict fails the audit
 * when a listed script is unguarded. Pending placeholders in the
 * domain map are never executed.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LOCAL_DATABASE_HOSTS,
  NEXT_BUILD_SCRIPTS,
  P1_DOMAINS,
  domainById,
  isDatabaseBacked,
} from "./p1-gate-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_HOSTS = new Set(LOCAL_DATABASE_HOSTS);
const BLOCKED_URL_PARAMS = new Set(["host", "hostaddr", "service"]);
const SCRUBBED_CHILD_ENV = [
  "DIRECT_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "PGHOST",
  "PGHOSTADDR",
  "PGSERVICE",
];
const URL_ENV_VARS = ["DIRECT_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL"];
const DEFAULT_CHILD_TIMEOUT_MS = 15 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const TEAM_ONBOARDING_SCRIPT = "scripts/check-team-onboarding.mjs";

let activeChild = null;
let stopSignal = null;
let signalsInstalled = false;

function usage() {
  const ids = P1_DOMAINS.map((domain) => `  ${domain.id}`).join("\n");
  return `Usage:
  node scripts/run-p1-gate.mjs <domain> [--fail-fast] [--allow-missing]
  node scripts/run-p1-gate.mjs <domain> --audit [--strict] [--allow-missing]

Domains:
${ids}

--audit scans listed scripts only (no database, no child processes).
--strict makes --audit exit non-zero when a listed script is unguarded.
--allow-missing skips a missing listed file instead of failing.
--fail-fast stops after the first script failure.

The gate never runs npm run build or next build.`;
}

function localUrlProblem(raw, label) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return `${label} is not a valid URL. The host must be exactly localhost, 127.0.0.1, or ::1.`;
  }
  for (const key of parsed.searchParams.keys()) {
    if (BLOCKED_URL_PARAMS.has(key.toLowerCase())) {
      return `${label} must not set query parameter "${key}". libpq and Prisma honor host, hostaddr, and service over the authority host.`;
    }
  }
  if (parsed.host.includes(",")) {
    return `${label} host must be a single host, not a comma-separated list (got ${parsed.host}).`;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    return `${label} host must be exactly localhost, 127.0.0.1, or ::1 (got ${host || "(empty)"}).`;
  }
  return null;
}

export function databaseHostProblem(raw) {
  if (!raw) {
    return "DATABASE_URL is not set. This domain includes a DB-backed script, so the host must be exactly localhost, 127.0.0.1, or ::1.";
  }
  return localUrlProblem(raw, "DATABASE_URL");
}

function bareHostProblem(raw, label) {
  const host = String(raw).trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host.includes(",") || host.includes("/") || !LOCAL_HOSTS.has(host)) {
    return `${label} must be exactly localhost, 127.0.0.1, or ::1 (got ${raw}).`;
  }
  return null;
}

export function alternateDatabaseEnvProblem(env = process.env) {
  for (const name of URL_ENV_VARS) {
    const value = env[name];
    if (value == null || String(value).trim() === "") continue;
    const problem = localUrlProblem(value, name);
    if (problem) return problem;
  }
  if (env.PGHOST != null && String(env.PGHOST).trim() !== "") {
    const problem = bareHostProblem(env.PGHOST, "PGHOST");
    if (problem) return problem;
  }
  if (env.PGHOSTADDR != null && String(env.PGHOSTADDR).trim() !== "") {
    const addr = String(env.PGHOSTADDR).trim().replace(/^\[|\]$/g, "").toLowerCase();
    if (addr !== "127.0.0.1" && addr !== "::1") {
      return `PGHOSTADDR must be exactly 127.0.0.1 or ::1 (got ${env.PGHOSTADDR}).`;
    }
  }
  if (env.PGSERVICE != null && String(env.PGSERVICE).trim() !== "") {
    return `PGSERVICE can point at a remote host and is not allowed (got ${env.PGSERVICE}).`;
  }
  return null;
}

export function childProcessEnv(base = process.env) {
  const env = { ...base, TZ: "America/New_York" };
  for (const name of SCRUBBED_CHILD_ENV) delete env[name];
  return env;
}

export function childTimeoutMs(env = process.env) {
  const raw = env.P1_GATE_CHILD_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === "") return DEFAULT_CHILD_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CHILD_TIMEOUT_MS;
  return parsed;
}

function maskComments(source) {
  let out = "";
  let i = 0;
  let state = "code";
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") {
        out += "  ";
        i += 2;
        state = "line";
        continue;
      }
      if (c === "/" && next === "*") {
        out += "  ";
        i += 2;
        state = "block";
        continue;
      }
      if (c === "'") {
        state = "single";
        out += c;
        i += 1;
        continue;
      }
      if (c === '"') {
        state = "double";
        out += c;
        i += 1;
        continue;
      }
      if (c === "`") {
        state = "template";
        out += c;
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += "\n";
      } else {
        out += " ";
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        out += "  ";
        i += 2;
        state = "code";
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (c === "\\") {
      out += c;
      if (i + 1 < source.length) {
        out += source[i + 1];
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (
      (state === "single" && c === "'") ||
      (state === "double" && c === '"') ||
      (state === "template" && c === "`")
    ) {
      state = "code";
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function firstMatch(source, pattern) {
  const match = pattern.exec(source);
  return match ? { index: match.index, text: match[0] } : null;
}

function lineIsExecutedDrop(line) {
  return (
    /\bDROP\s+DATABASE\b/i.test(line) &&
    !line.includes(".includes(") &&
    (/IF\s+EXISTS/i.test(line) || /executeRaw/i.test(line) || /["']-c["']/.test(line))
  );
}

function firstExecutedDrop(masked) {
  const lines = masked.split("\n");
  let offset = 0;
  for (const line of lines) {
    if (lineIsExecutedDrop(line)) {
      const at = line.search(/\bDROP\s+DATABASE\b/i);
      return { index: offset + at, text: "DROP DATABASE" };
    }
    offset += line.length + 1;
  }
  return null;
}

function prefixHasLocalhostGuard(prefix) {
  const comparesHost =
    /(?:===|!==)\s*["']localhost["']/.test(prefix) ||
    /(?:===|!==)\s*["']127\.0\.0\.1["']/.test(prefix) ||
    /(?:===|!==)\s*["']::1["']/.test(prefix) ||
    /new\s+Set\(\s*\[[\s\S]{0,400}?["'](?:localhost|127\.0\.0\.1|::1)["']/.test(prefix);
  const refuses =
    /process\.exit/.test(prefix) ||
    /refus/i.test(prefix);
  return comparesHost && refuses;
}

function analyzeDrops(masked) {
  const lines = masked.split("\n");
  const drops = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!lineIsExecutedDrop(line)) continue;
    const window = lines.slice(i, i + 3).join("\n");
    const force = /DROP\s+DATABASE\s+IF\s+EXISTS[\s\S]{0,200}?WITH\s*\(\s*FORCE\s*\)/i.test(window);
    drops.push({ line: i + 1, force });
  }
  return drops;
}

function usesAcceptDataLoss(masked) {
  return masked.split("\n").some((line) => {
    return line.includes("--accept-data-loss") && !line.includes(".includes(");
  });
}

/**
 * Static scan of one check script. Does not connect or spawn.
 * A script is unguarded when a PrismaClient creation, `prisma db push`,
 * or DROP DATABASE appears before a localhost-only refusal, or when
 * `--accept-data-loss` is used without that guard.
 */
export function auditScriptSource(scriptPath, source) {
  const masked = maskComments(source);
  const candidates = [
    // `\w*Prisma\w*` so PrismaClient matches. A leading character class
    // would consume the "P" and then miss the literal "Prisma".
    firstMatch(masked, /\bnew\s+\w*Prisma\w*\s*\(/),
    firstMatch(masked, /["']db["']\s*,\s*["']push["']/),
    firstExecutedDrop(masked),
  ].filter(Boolean);
  candidates.sort((a, b) => a.index - b.index);
  const first = candidates[0] ?? null;
  const dangerous = Boolean(first);
  const guard = dangerous ? prefixHasLocalhostGuard(masked.slice(0, first.index)) : null;
  const drops = analyzeDrops(masked);
  const acceptDataLoss = usesAcceptDataLoss(masked);
  const acceptDataLossUnguarded = acceptDataLoss && guard !== true;
  let firstOp = "none";
  if (first) {
    if (/new\s+/.test(first.text)) firstOp = "new PrismaClient";
    else if (/push/.test(first.text)) firstOp = "prisma db push";
    else firstOp = "DROP DATABASE";
  }
  let dropForce = "none";
  if (drops.length > 0) dropForce = drops.every((drop) => drop.force) ? "yes" : "no";
  const unguarded = (dangerous && guard !== true) || acceptDataLossUnguarded;
  const warnings = [];
  if (unguarded) {
    warnings.push("no localhost-only guard before the first PrismaClient / prisma db push / DROP DATABASE");
  }
  if (acceptDataLossUnguarded) {
    warnings.push("uses --accept-data-loss unguarded");
  }
  if (dropForce === "no") {
    warnings.push("cleanup DROP DATABASE is not DROP DATABASE IF EXISTS ... WITH (FORCE)");
  }
  if (dangerous && dropForce === "none") {
    warnings.push("no DROP DATABASE cleanup found");
  }
  return {
    scriptPath,
    dangerous,
    firstOp,
    localhostGuard: dangerous ? (guard ? "yes" : "no") : "n/a",
    dropForce,
    acceptDataLoss: acceptDataLoss ? (acceptDataLossUnguarded ? "unguarded" : "guarded") : "not used",
    unguarded,
    warnings,
  };
}

export function auditScriptFile(scriptPath) {
  const absolute = join(repoRoot, scriptPath);
  if (!existsSync(absolute)) {
    return {
      scriptPath,
      missing: true,
      dangerous: false,
      firstOp: "missing",
      localhostGuard: "missing",
      dropForce: "missing",
      acceptDataLoss: "missing",
      unguarded: false,
      warnings: ["listed script file is missing"],
    };
  }
  const source = readFileSync(absolute, "utf8");
  return { ...auditScriptSource(scriptPath, source), missing: false };
}

function markdownCell(value) {
  return String(value).replace(/\|/g, "\\|");
}

export function formatAuditTable(domain, rows) {
  const header = [
    "| Script | First dangerous op | Localhost guard before it | DROP DATABASE IF EXISTS ... WITH (FORCE) | --accept-data-loss | Audit |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const body = rows.map((row) => {
    const audit = row.missing ? "MISSING" : row.unguarded ? "UNGUARDED" : row.warnings.length ? "WARN" : "ok";
    return `| ${markdownCell(row.scriptPath)} | ${markdownCell(row.firstOp)} | ${markdownCell(row.localhostGuard)} | ${markdownCell(row.dropForce)} | ${markdownCell(row.acceptDataLoss)} | ${audit} |`;
  });
  return [`### ${domain.id}`, "", ...header, ...body].join("\n");
}

function assertPendingNotRegistered(domain) {
  const registered = new Set(domain.scripts);
  for (const item of domain.pending ?? []) {
    if (item.placeholder && registered.has(item.placeholder)) {
      throw new Error(
        `Pending placeholder ${item.placeholder} is registered in ${domain.id}. Pending tests must not be executed.`,
      );
    }
  }
}

function packageInvocation(scriptPath) {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const commands = Object.values(packageJson.scripts ?? {}).filter(
    (command) => typeof command === "string" && command.includes(scriptPath),
  );
  const nodeCommand = commands.find((command) => /^\s*node\b/.test(command) && !command.includes("&&"));
  const chosen = nodeCommand ?? commands.find((command) => command.includes("node")) ?? null;
  const stripTypes = !chosen || chosen.includes("--experimental-strip-types");
  const args = stripTypes ? ["--experimental-strip-types", scriptPath] : [scriptPath];
  if (args.some((arg) => /\b(npm|npx)\b/.test(arg) || /\bnext\b/.test(arg))) {
    throw new Error(`Refusing to launch ${scriptPath}: resolved args would invoke npm or next.`);
  }
  return { exec: process.execPath, args, mode: stripTypes ? "strip-types" : "plain-node" };
}

function hasNextBuild() {
  const buildDir = join(repoRoot, ".next");
  try {
    return statSync(buildDir).isDirectory();
  } catch {
    return false;
  }
}

export function nextBuildBlockReason(scriptPath) {
  if (!NEXT_BUILD_SCRIPTS.has(scriptPath)) return null;
  if (hasNextBuild()) return null;
  return "requires prior next build (no .next directory). This gate does not run npm run build or next build.";
}

export function httpSectionSkipWarning(scriptPath) {
  if (scriptPath !== TEAM_ONBOARDING_SCRIPT) return null;
  if (hasNextBuild()) return null;
  return `WARN  ${scriptPath}  no .next directory; this script skips its HTTP section. The gate does not run next build.`;
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function installSignalHandlers() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  const onSignal = (signal) => {
    if (stopSignal) {
      if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
        activeChild.kill("SIGKILL");
      }
      return;
    }
    stopSignal = signal;
    console.error(`P1 gate received ${signal}; forwarding it to the running child.`);
    const child = activeChild;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
      const grace = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      grace.unref();
    }
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}

export function launchChild({ exec, args, env, cwd = repoRoot, timeoutMs, stdio = "inherit" }) {
  installSignalHandlers();
  const started = performance.now();
  const limit = timeoutMs ?? childTimeoutMs(env);
  return new Promise((resolvePromise) => {
    const child = spawn(exec, args, {
      cwd,
      env: childProcessEnv(env),
      stdio,
    });
    activeChild = child;
    let settled = false;
    let timedOut = false;
    let timer;
    let killTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (activeChild === child) activeChild = null;
      resolvePromise(result);
    };
    timer = setTimeout(() => {
      timedOut = true;
      console.error(`Child timed out after ${formatSeconds(limit)}; sending SIGTERM.`);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    }, limit);
    if (settled) clearTimeout(timer);
    child.on("error", (error) => {
      finish({
        code: 1,
        signal: null,
        ms: performance.now() - started,
        error,
        timedOut,
        stopped: stopSignal,
      });
    });
    child.on("close", (code, signal) => {
      finish({
        code: code ?? 1,
        signal: signal ?? null,
        ms: performance.now() - started,
        error: null,
        timedOut,
        stopped: stopSignal,
      });
    });
  });
}

async function runDomain(domain, options) {
  assertPendingNotRegistered(domain);
  const dbBacked = domain.scripts.filter((scriptPath) => isDatabaseBacked(scriptPath));
  if (dbBacked.length > 0) {
    const problem =
      databaseHostProblem(process.env.DATABASE_URL) || alternateDatabaseEnvProblem(process.env);
    if (problem) {
      console.error(`P1 gate refused to start ${domain.id}.`);
      console.error(problem);
      console.error("No child process was started.");
      return 1;
    }
  }

  console.log(`P1 gate ${domain.id}`);
  console.log(`TZ forced to America/New_York for child processes`);
  if (dbBacked.length > 0) {
    console.log(`DATABASE_URL host accepted before any child (${dbBacked.length} DB-backed script(s))`);
  } else {
    console.log("No DB-backed script in this domain; DATABASE_URL was not required");
  }

  const results = [];
  let childrenStarted = 0;
  for (const scriptPath of domain.scripts) {
    if (stopSignal) break;
    const absolute = join(repoRoot, scriptPath);
    if (!existsSync(absolute)) {
      const message = `missing file ${scriptPath}`;
      if (options.allowMissing) {
        console.error(`SKIP  ${scriptPath}  ${message} (--allow-missing)`);
        results.push({ scriptPath, status: "skip", ms: 0 });
        continue;
      }
      console.error(`FAIL  ${scriptPath}  ${message}. Listed scripts fail closed. Pass --allow-missing only for interim wiring.`);
      results.push({ scriptPath, status: "fail", ms: 0 });
      if (options.failFast) break;
      continue;
    }
    const buildBlock = nextBuildBlockReason(scriptPath);
    if (buildBlock) {
      console.error(`FAIL  ${scriptPath}  ${buildBlock}`);
      results.push({ scriptPath, status: "fail", ms: 0 });
      if (options.failFast) break;
      continue;
    }
    const skipHttp = httpSectionSkipWarning(scriptPath);
    if (skipHttp) console.error(skipHttp);
    const invocation = packageInvocation(scriptPath);
    console.log(`\n--- ${scriptPath} (${invocation.mode}) ---`);
    childrenStarted += 1;
    const outcome = await launchChild({
      exec: invocation.exec,
      args: invocation.args,
      env: process.env,
    });
    if (stopSignal) {
      console.error(`FAIL  ${scriptPath}  stopped by ${stopSignal}`);
      results.push({ scriptPath, status: "fail", ms: outcome.ms, code: outcome.code ?? 1 });
      break;
    }
    const status = outcome.code === 0 && !outcome.signal && !outcome.timedOut ? "pass" : "fail";
    const detail = outcome.timedOut
      ? `timed out after ${formatSeconds(childTimeoutMs())} (${outcome.signal ? `signal ${outcome.signal}` : `exit ${outcome.code}`})`
      : outcome.signal
        ? `signal ${outcome.signal}`
        : `exit ${outcome.code}`;
    console.log(`${status === "pass" ? "PASS" : "FAIL"}  ${scriptPath}  ${formatSeconds(outcome.ms)}  ${detail}`);
    results.push({ scriptPath, status, ms: outcome.ms, code: outcome.code });
    if (status === "fail" && options.failFast) break;
  }
  if (stopSignal) {
    console.error(`P1 gate stopped because of ${stopSignal}.`);
    return stopSignal === "SIGINT" ? 130 : 143;
  }

  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.filter((result) => result.status === "fail").length;
  const skipped = results.filter((result) => result.status === "skip").length;
  const elapsed = results.reduce((sum, result) => sum + result.ms, 0);
  console.log("");
  console.log(
    `Summary ${domain.id}: ${passed} passed, ${failed} failed, ${skipped} skipped (${results.length} listed) in ${formatSeconds(elapsed)}. Child processes started: ${childrenStarted}.`,
  );
  return failed === 0 ? 0 : 1;
}

function runAudit(domain, options) {
  assertPendingNotRegistered(domain);
  console.log(`P1 gate audit ${domain.id}`);
  console.log("Static scan only. No database connection and no child scripts.");
  console.log("Existing scripts are not modified. Findings are warnings unless --strict.");
  const rows = [];
  let missing = 0;
  for (const scriptPath of domain.scripts) {
    const row = auditScriptFile(scriptPath);
    rows.push(row);
    if (row.missing) missing += 1;
  }
  console.log("");
  console.log(formatAuditTable(domain, rows));
  console.log("");
  const unguarded = rows.filter((row) => row.unguarded);
  const warned = rows.filter((row) => row.warnings.length > 0);
  if (warned.length === 0) {
    console.log("Warnings: none");
  } else {
    console.log("Warnings:");
    for (const row of warned) {
      for (const warning of row.warnings) {
        console.log(`- ${row.scriptPath}: ${warning}`);
      }
    }
  }
  const pending = domain.pending ?? [];
  if (pending.length > 0) {
    console.log("");
    console.log("Pending (not registered, not executed):");
    for (const item of pending) {
      console.log(`- ${item.placeholder}: ${item.requirement}`);
    }
  }
  const failForMissing = missing > 0 && !options.allowMissing;
  const failForUnguarded = options.strict && unguarded.length > 0;
  if (failForMissing) {
    console.error(`\nAudit failed: ${missing} listed script file(s) missing.`);
  }
  if (failForUnguarded) {
    console.error(`\nAudit failed (--strict): ${unguarded.length} unguarded script(s).`);
  }
  if (!failForMissing && !failForUnguarded) {
    console.log(`\nAudit result: report only (${unguarded.length} unguarded, ${warned.length} with findings).`);
  }
  return failForMissing || failForUnguarded ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  const flags = new Set();
  const positionals = [];
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") flags.add("--help");
    else if (arg.startsWith("--")) flags.add(arg);
    else positionals.push(arg);
  }
  const known = new Set(["--help", "--audit", "--strict", "--allow-missing", "--fail-fast"]);
  for (const flag of flags) {
    if (!known.has(flag)) {
      console.error(`Unknown flag ${flag}\n\n${usage()}`);
      return 1;
    }
  }
  if (flags.has("--help")) {
    console.log(usage());
    return 0;
  }
  if (flags.has("--strict") && !flags.has("--audit")) {
    console.error("--strict applies to --audit only.\n\n" + usage());
    return 1;
  }
  if (positionals.length !== 1) {
    console.error(usage());
    return 1;
  }
  const domain = domainById(positionals[0]);
  if (!domain) {
    console.error(`Unknown P1 domain "${positionals[0]}".\n\n${usage()}`);
    return 1;
  }
  const options = {
    allowMissing: flags.has("--allow-missing"),
    failFast: flags.has("--fail-fast"),
    strict: flags.has("--strict"),
  };
  if (flags.has("--audit")) return runAudit(domain, options);
  return runDomain(domain, options);
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}

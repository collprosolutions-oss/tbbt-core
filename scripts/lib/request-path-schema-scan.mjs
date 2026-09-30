/**
 * Repo-wide request-path schema scanner.
 *
 * Walks executable Prisma raw-SQL call sites under src/. Historical
 * CREATE/ALTER/backfill stand-in constants are not violations unless a
 * request-path $executeRaw / $executeRawUnsafe actually runs them.
 * Advisory locks, SELECT FOR UPDATE, and application INSERT ON CONFLICT
 * are classified, not rejected.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { classifyRequestPathSql } from "../production-migrate-policy.mjs";

const WRITE_METHODS = new Set(["$executeRaw", "$executeRawUnsafe"]);

function walkTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walkTsFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function skipTemplateExpr(source, start) {
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      const quoted = readQuoted(source, i);
      i = quoted ? quoted.end : i + 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    i += 1;
  }
  return i;
}

function readQuoted(source, start) {
  const quote = source[start];
  let i = start + 1;
  let value = "";
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      value += source[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (quote === "`" && c === "$" && source[i + 1] === "{") {
      value += "${}";
      i = skipTemplateExpr(source, i + 2);
      continue;
    }
    if (c === quote) {
      return { value, raw: source.slice(start, i + 1), end: i + 1 };
    }
    value += c;
    i += 1;
  }
  return null;
}

function readValue(source, start) {
  const ch = source[start];
  if (ch === "`" || ch === '"' || ch === "'") {
    const text = readQuoted(source, start);
    return text
      ? { kind: "string", text: text.value, end: text.end }
      : null;
  }
  if (ch === "[") {
    const items = [];
    let i = start + 1;
    while (i < source.length) {
      while (i < source.length && /[\s,]/.test(source[i])) i += 1;
      if (source[i] === "]") {
        return { kind: "array", items, text: items.join("\n"), end: i + 1 };
      }
      if (source[i] === "`" || source[i] === '"' || source[i] === "'") {
        const quoted = readQuoted(source, i);
        if (quoted) {
          items.push(quoted.value);
          i = quoted.end;
          continue;
        }
      }
      i += 1;
    }
  }
  return null;
}

function extractConstBindings(source) {
  const bindings = new Map();
  const constRe = /(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/g;
  let match;
  while ((match = constRe.exec(source))) {
    const value = readValue(source, match.index + match[0].length);
    if (value) bindings.set(match[1], value);
  }
  return bindings;
}

function skipTypeArgs(source, start) {
  if (source[start] !== "<") return start;
  let depth = 0;
  let i = start;
  while (i < source.length) {
    if (source[i] === "<") depth += 1;
    else if (source[i] === ">") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return start;
}

function readTaggedTemplateArg(source, tickIndex) {
  let i = tickIndex + 1;
  let value = "";
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      value += source[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (c === "`") {
      if (/^\s*[,);]/.test(source.slice(i + 1))) {
        return { value, end: i + 1 };
      }
    }
    value += c;
    i += 1;
  }
  return null;
}

function readCallArg(source, start) {
  let i = start;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (source[i] === "`" || source[i] === '"' || source[i] === "'") {
    const quoted =
      source[i] === "`"
        ? readTaggedTemplateArg(source, i) ?? readQuoted(source, i)
        : readQuoted(source, i);
    return { text: quoted?.value ?? "", ident: null };
  }
  const prismaSql = source.slice(i).match(/^Prisma\.sql\s*`/);
  if (prismaSql) {
    const quoted = readTaggedTemplateArg(source, i + prismaSql[0].length - 1);
    return { text: quoted?.value ?? "", ident: "Prisma.sql" };
  }
  const ident = source.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  if (ident) return { text: "", ident: ident[1] };
  return { text: "", ident: null };
}

function findRawCalls(source) {
  const calls = [];
  const re = /\$((?:execute|query)Raw(?:Unsafe)?)/g;
  let match;
  while ((match = re.exec(source))) {
    const method = `$${match[1]}`;
    let cursor = skipTypeArgs(source, match.index + match[0].length);
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (source[cursor] === "`") {
      const quoted = readQuoted(source, cursor);
      calls.push({
        method,
        style: "tagged",
        arg: quoted?.value ?? "",
        argName: null,
        index: match.index,
      });
    } else if (source[cursor] === "(") {
      const arg = readCallArg(source, cursor + 1);
      calls.push({
        method,
        style: "call",
        arg: arg.text,
        argName: arg.ident,
        index: match.index,
      });
    }
  }
  return calls;
}

function resolveLoopBinding(source, ident, callIndex) {
  const before = source.slice(0, callIndex);
  const loops = [...before.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s+([A-Za-z_][A-Za-z0-9_]*)/g)];
  const loop = loops.pop();
  if (loop && loop[1] === ident) return loop[2];
  return null;
}

function classifyCallKind(sql, method) {
  const classified = classifyRequestPathSql(sql);
  const text = String(sql ?? "");
  if (classified.schemaDdl) {
    return { kind: "schema-ddl", ...classified };
  }
  if (classified.backfillDml) {
    return { kind: "migration-backfill", ...classified };
  }
  if (/\bpg_advisory_xact_lock\b/i.test(text)) {
    return { kind: "advisory-lock", ...classified };
  }
  if (/^\s*SELECT\b/i.test(text) && /\bFOR\s+UPDATE\b/i.test(text)) {
    return { kind: "row-lock", ...classified };
  }
  if (/^\s*(SELECT|WITH)\b/i.test(text)) {
    return { kind: "read", ...classified };
  }
  if (/\bINSERT\s+INTO\b/i.test(text) && /\bON\s+CONFLICT\b/i.test(text)) {
    return { kind: "app-upsert", ...classified };
  }
  if (/\b(INSERT|UPDATE|DELETE)\b/i.test(text)) {
    return { kind: "transactional-write", ...classified };
  }
  if (WRITE_METHODS.has(method) && !text.trim()) {
    return { kind: "unresolved-write", ...classified };
  }
  return { kind: "other", ...classified };
}

export function scanSourceText(relPath, source) {
  const bindings = extractConstBindings(source);
  const executable = [];
  for (const call of findRawCalls(source)) {
    let sql = call.arg;
    let resolvedFrom = call.argName;
    if (call.argName) {
      const loopOf = resolveLoopBinding(source, call.argName, call.index);
      const name = loopOf || call.argName;
      const binding = bindings.get(name);
      if (binding) {
        sql = binding.kind === "array" ? binding.items.join("\n;\n") : binding.text;
        resolvedFrom = name;
      } else if (!sql.trim()) {
        sql = "";
        resolvedFrom = name;
      }
    }
    const classification = classifyCallKind(sql, call.method);
    const looksLikeEnsureArg =
      /ENSURE_|CREATE_|BACKFILL_|REPAIR_|CONSTRAINTS_SQL/i.test(resolvedFrom || "") ||
      /ensure[A-Z][A-Za-z]+(Schema|Table|Tables|Columns|Backfill)/.test(source.slice(Math.max(0, call.index - 240), call.index));
    const unresolvedUnsafeEnsure =
      WRITE_METHODS.has(call.method) &&
      !sql.trim() &&
      looksLikeEnsureArg;
    const violation =
      (WRITE_METHODS.has(call.method) &&
        (classification.schemaDdl || classification.backfillDml)) ||
      unresolvedUnsafeEnsure;
    executable.push({
      file: relPath,
      method: call.method,
      style: call.style,
      resolvedFrom,
      sqlPreview: sql.slice(0, 180).replace(/\s+/g, " ").trim(),
      ...classification,
      violation,
    });
  }

  const standIns = [];
  for (const [name, binding] of bindings) {
    const classification = classifyRequestPathSql(binding.text);
    const executed = executable.some(
      (row) => row.resolvedFrom === name && (row.schemaDdl || row.backfillDml),
    );
    if ((classification.schemaDdl || classification.backfillDml) && !executed) {
      standIns.push({
        file: relPath,
        name,
        kind: classification.schemaDdl ? "schema-ddl-stand-in" : "backfill-stand-in",
        ...classification,
      });
    }
  }

  return {
    file: relPath,
    executable,
    standIns,
    violations: executable.filter((row) => row.violation),
  };
}

export function scanSrcTree(repoRoot) {
  const srcRoot = path.join(repoRoot, "src");
  const files = walkTsFiles(srcRoot);
  const results = files.map((full) =>
    scanSourceText(
      path.relative(repoRoot, full).split(path.sep).join("/"),
      readFileSync(full, "utf8"),
    ),
  );
  return {
    results,
    violations: results.flatMap((row) => row.violations),
    executable: results.flatMap((row) => row.executable),
    standIns: results.flatMap((row) => row.standIns),
  };
}

export function classifyRemainingRawSql(scan) {
  const groups = {
    "schema-ddl": [],
    "migration-backfill": [],
    "advisory-lock": [],
    "row-lock": [],
    read: [],
    "app-upsert": [],
    "transactional-write": [],
    "unresolved-write": [],
    other: [],
  };
  for (const row of scan.executable) {
    (groups[row.kind] ?? groups.other).push(row);
  }
  return groups;
}

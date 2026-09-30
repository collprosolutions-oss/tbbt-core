/**
 * Repo-wide request-path schema scanner.
 *
 * $executeRawUnsafe and $queryRawUnsafe are prohibited under src/ in
 * every executable form: calls, binds, aliases, bracket access,
 * wrappers, concatenated SQL, and imported/renamed constants.
 *
 * $executeRaw / $queryRaw stay classified: advisory locks, SELECT FOR
 * UPDATE, presence-probe reads, and application INSERT ON CONFLICT
 * are allowed. Schema DDL / migration-style backfill on those APIs —
 * including Prisma.raw / Prisma.sql wrappers — is a violation.
 * $queryRaw executes writes on Postgres, so CREATE/ALTER/backfill
 * through tagged $queryRaw is not a read.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { classifyRequestPathSql } from "../production-migrate-policy.mjs";

const WRITE_CAPABLE_METHODS = new Set([
  "$executeRaw",
  "$executeRawUnsafe",
  "$queryRaw",
  "$queryRawUnsafe",
]);
const UNSAFE_METHODS = new Set(["$executeRawUnsafe", "$queryRawUnsafe"]);

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
  const prismaRaw = source.slice(i).match(/^Prisma\.raw\b/);
  if (prismaRaw) {
    let cursor = skipWs(source, i + prismaRaw[0].length);
    if (source[cursor] === "(") return { ...readCallArg(source, cursor + 1), ident: "Prisma.raw" };
    if (source[cursor] === "`") {
      const quoted = readTaggedTemplateArg(source, cursor) ?? readQuoted(source, cursor);
      return { text: quoted?.value ?? "", ident: "Prisma.raw" };
    }
    return { text: "", ident: "Prisma.raw" };
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

function blankComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "/") {
      out += "  ";
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (source[i] === "/" && source[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < source.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (source[i] === "'" || source[i] === '"' || source[i] === "`") {
      const quoted = readQuoted(source, i);
      if (quoted) {
        out += source.slice(i, quoted.end);
        i = quoted.end;
        continue;
      }
    }
    out += source[i];
    i += 1;
  }
  return out;
}

function skipWs(source, start) {
  let i = start;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  return i;
}

function skipWsAndOptionalChain(source, start) {
  let i = skipWs(source, start);
  if (source[i] === "?" && source[i + 1] === ".") {
    i = skipWs(source, i + 2);
  }
  return i;
}

function isUnsafeBracketIdent(source, identIndex) {
  const before = source.slice(Math.max(0, identIndex - 12), identIndex);
  return /\[\s*['"`]$/.test(before);
}

function finishUnsafeAccess(source, afterAccess, index, stylePrefix, method) {
  const afterWs = skipWs(source, afterAccess);
  if (/^(\?\.|\.)\s*bind\b/.test(source.slice(afterWs))) {
    return {
      method,
      style: `${stylePrefix}-bind`,
      arg: "",
      argName: null,
      index,
    };
  }
  const cursor = skipWsAndOptionalChain(source, afterAccess);
  if (source[cursor] === "(") {
    const arg = readCallArg(source, cursor + 1);
    return {
      method,
      style: `${stylePrefix}-call`,
      arg: arg.text,
      argName: arg.ident,
      index,
    };
  }
  return {
    method,
    style: `${stylePrefix}-ref`,
    arg: "",
    argName: null,
    index,
  };
}

function findRawCalls(source) {
  const code = blankComments(source);
  const calls = [];

  const bracketRe = /(\?\.)?\s*\[\s*(['"`])(\$(?:execute|query)RawUnsafe)\2\s*\]/g;
  let match;
  while ((match = bracketRe.exec(code))) {
    calls.push(
      finishUnsafeAccess(
        source,
        match.index + match[0].length,
        match.index,
        "bracket",
        match[3],
      ),
    );
  }

  const re = /\$((?:execute|query)Raw(?:Unsafe)?)/g;
  while ((match = re.exec(code))) {
    const method = `$${match[1]}`;
    if (UNSAFE_METHODS.has(method) && isUnsafeBracketIdent(code, match.index)) {
      continue;
    }
    let cursor = skipTypeArgs(code, match.index + match[0].length);
    cursor = skipWs(code, cursor);
    if (code[cursor] === "`") {
      const quoted = readQuoted(source, cursor);
      calls.push({
        method,
        style: "tagged",
        arg: quoted?.value ?? "",
        argName: null,
        index: match.index,
      });
      continue;
    }
    if (code[cursor] === "(") {
      const arg = readCallArg(source, cursor + 1);
      calls.push({
        method,
        style: "call",
        arg: arg.text,
        argName: arg.ident,
        index: match.index,
      });
      continue;
    }
    if (UNSAFE_METHODS.has(method)) {
      calls.push(
        finishUnsafeAccess(source, match.index + match[0].length, match.index, "ident", method),
      );
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
  if (WRITE_CAPABLE_METHODS.has(method) && !text.trim()) {
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
    const unresolvedPrismaRaw =
      resolvedFrom === "Prisma.raw" &&
      WRITE_CAPABLE_METHODS.has(call.method) &&
      !sql.trim();
    const violation =
      UNSAFE_METHODS.has(call.method) ||
      unresolvedPrismaRaw ||
      (WRITE_CAPABLE_METHODS.has(call.method) &&
        (classification.schemaDdl || classification.backfillDml));
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

  const unsafeRefs = executable.filter((row) => UNSAFE_METHODS.has(row.method));
  return {
    file: relPath,
    executable,
    standIns,
    unsafeRefs,
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
    unsafeRefs: results.flatMap((row) => row.unsafeRefs),
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

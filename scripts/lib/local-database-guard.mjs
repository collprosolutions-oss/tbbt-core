/**
 * Canonical “is this database URL safely local?” check for P1 scripts.
 *
 * Used by the disposable-test-database harness (#235) and intended as
 * the shared definition for the P1 regression gate (#238) after
 * integration. Do not weaken either side:
 * - reject remote / non-Postgres destinations
 * - reject ambiguous query-param hosts (duplicates, mixed case, encoded)
 * - reject hostaddr and service (libpq/Prisma honor them over authority)
 * - handle IPv6 and local-socket authority forms intentionally
 * - check alternate DB environment variables that Prisma/libpq also read
 */
export const LOCAL_DATABASE_HOSTS = ["localhost", "127.0.0.1", "::1"];

export const BLOCKED_URL_PARAMS = ["host", "hostaddr", "service"];

export const ALTERNATE_DATABASE_URL_ENV = [
  "DIRECT_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
];

export const ALTERNATE_DATABASE_HOST_ENV = [
  "PGHOST",
  "PGHOSTADDR",
  "PGSERVICE",
];

export const SCRUBBED_DATABASE_ENV = [
  ...ALTERNATE_DATABASE_URL_ENV,
  ...ALTERNATE_DATABASE_HOST_ENV,
];

const LOCAL_HOSTS = new Set(LOCAL_DATABASE_HOSTS);
const BLOCKED_PARAM_SET = new Set(BLOCKED_URL_PARAMS);

export class RemoteDatabaseRefusedError extends Error {
  constructor(message, { host, action } = {}) {
    super(message);
    this.name = "RemoteDatabaseRefusedError";
    this.host = host ?? "";
    this.action = action ?? "";
  }
}

function decodeQueryComponent(raw) {
  try {
    return decodeURIComponent(String(raw).replace(/\+/g, " "));
  } catch {
    return String(raw);
  }
}

function queryPairsFromUrlString(urlString) {
  const raw = String(urlString ?? "");
  const q = raw.indexOf("?");
  if (q < 0) return [];
  const query = raw.slice(q + 1).split("#")[0];
  return query.split("&").filter(Boolean).map((part) => {
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? "" : part.slice(eq + 1);
    return {
      key: decodeQueryComponent(rawKey),
      value: decodeQueryComponent(rawValue),
    };
  });
}

function parseDatabaseUrl(urlString) {
  try {
    return new URL(urlString);
  } catch {
    try {
      return new URL(String(urlString).replace(/@\//, "@localhost/"));
    } catch {
      return null;
    }
  }
}

function stripHostBrackets(value) {
  return String(value ?? "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
}

function isLocalSocketAuthority(host) {
  return !host || host.startsWith("/");
}

function isAllowedLocalHost(host) {
  return LOCAL_HOSTS.has(host) || isLocalSocketAuthority(host);
}

function blockedQueryParamProblem(urlString, label) {
  const pairs = queryPairsFromUrlString(urlString);
  const counts = new Map();
  const values = new Map();
  for (const { key, value } of pairs) {
    const lower = key.toLowerCase();
    if (!BLOCKED_PARAM_SET.has(lower)) continue;
    counts.set(lower, (counts.get(lower) || 0) + 1);
    if (!values.has(lower)) values.set(lower, []);
    values.get(lower).push(value);
  }

  for (const name of BLOCKED_URL_PARAMS) {
    if ((counts.get(name) || 0) > 1) {
      return `${label} must not repeat query parameter "${name}". libpq and Prisma may honor a different value than the first.`;
    }
  }

  const hostValues = values.get("host") ?? [];
  const hostaddrValues = values.get("hostaddr") ?? [];
  const serviceValues = values.get("service") ?? [];

  if (hostValues.some((value) => String(value).includes(","))) {
    return `${label} host query parameter must be a single host, not a comma-separated list.`;
  }
  if (hostaddrValues.some((value) => String(value).trim() !== "")) {
    return `${label} must not set query parameter "hostaddr". libpq and Prisma honor hostaddr over the authority host.`;
  }
  if (serviceValues.some((value) => String(value).trim() !== "")) {
    return `${label} must not set query parameter "service". libpq and Prisma honor service over the authority host.`;
  }
  if (hostValues.length > 0) {
    return `${label} must not set query parameter "host". libpq and Prisma honor host, hostaddr, and service over the authority host.`;
  }
  return null;
}

/**
 * Returns a problem string if the URL is not an unambiguous local
 * Postgres destination. Returns null when the destination is safe.
 */
export function databaseUrlProblem(raw, label = "DATABASE_URL") {
  if (raw == null || String(raw).trim() === "") {
    return `${label} is not set. The host must be exactly localhost, 127.0.0.1, ::1, or a local socket.`;
  }
  const parsed = parseDatabaseUrl(raw);
  if (!parsed) {
    return `${label} is not a valid URL. The host must be exactly localhost, 127.0.0.1, ::1, or a local socket.`;
  }
  const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (protocol !== "postgres" && protocol !== "postgresql") {
    return `${label} must be a postgres or postgresql URL (got ${protocol || "unknown"}).`;
  }

  const queryProblem = blockedQueryParamProblem(raw, label);
  if (queryProblem) return queryProblem;

  for (const key of parsed.searchParams.keys()) {
    if (BLOCKED_PARAM_SET.has(key.toLowerCase())) {
      return `${label} must not set query parameter "${key}". libpq and Prisma honor host, hostaddr, and service over the authority host.`;
    }
  }

  if (parsed.host.includes(",") || parsed.hostname.includes(",")) {
    return `${label} host must be a single host, not a comma-separated list (got ${parsed.host}).`;
  }

  const host = stripHostBrackets(parsed.hostname);
  if (!isAllowedLocalHost(host)) {
    return `${label} host must be exactly localhost, 127.0.0.1, ::1, or a local socket (got ${host || "(empty)"}).`;
  }
  return null;
}

export function isLocalDatabaseUrl(urlString) {
  return databaseUrlProblem(urlString, "DATABASE_URL") == null;
}

/** @deprecated use isLocalDatabaseUrl — kept as the #235 export name */
export function isLocalDatabaseHost(urlString) {
  return isLocalDatabaseUrl(urlString);
}

export function databaseHostProblem(raw) {
  return databaseUrlProblem(raw, "DATABASE_URL");
}

function bareHostProblem(raw, label) {
  const host = stripHostBrackets(raw);
  if (!host || host.includes(",") || host.includes("/") || !LOCAL_HOSTS.has(host)) {
    return `${label} must be exactly localhost, 127.0.0.1, or ::1 (got ${raw}).`;
  }
  return null;
}

export function alternateDatabaseEnvProblem(env = process.env) {
  for (const name of ALTERNATE_DATABASE_URL_ENV) {
    const value = env[name];
    if (value == null || String(value).trim() === "") continue;
    const problem = databaseUrlProblem(value, name);
    if (problem) return problem;
  }
  if (env.PGHOST != null && String(env.PGHOST).trim() !== "") {
    const problem = bareHostProblem(env.PGHOST, "PGHOST");
    if (problem) return problem;
  }
  if (env.PGHOSTADDR != null && String(env.PGHOSTADDR).trim() !== "") {
    const addr = stripHostBrackets(env.PGHOSTADDR);
    if (addr !== "127.0.0.1" && addr !== "::1") {
      return `PGHOSTADDR must be exactly 127.0.0.1 or ::1 (got ${env.PGHOSTADDR}).`;
    }
  }
  if (env.PGSERVICE != null && String(env.PGSERVICE).trim() !== "") {
    return `PGSERVICE can point at a remote host and is not allowed (got ${env.PGSERVICE}).`;
  }
  return null;
}

export function localDatabaseEnvironmentProblem(databaseUrl, env = process.env) {
  return databaseUrlProblem(databaseUrl, "DATABASE_URL") || alternateDatabaseEnvProblem(env);
}

export function scrubAlternateDatabaseEnv(base = process.env) {
  const env = { ...base };
  for (const name of SCRUBBED_DATABASE_ENV) delete env[name];
  return env;
}

export function assertLocalDatabaseUrl(urlString, action = "destructive database work", env) {
  const problem =
    env === undefined
      ? databaseUrlProblem(urlString, "DATABASE_URL")
      : localDatabaseEnvironmentProblem(urlString, env);
  if (!problem) {
    return parseDatabaseUrl(urlString);
  }
  const parsed = parseDatabaseUrl(urlString);
  const host = parsed ? stripHostBrackets(parsed.hostname) || parsed.host : "";
  throw new RemoteDatabaseRefusedError(`Refusing to ${action}: ${problem}`, {
    host,
    action,
  });
}

export function assertSafeLocalDatabaseEnvironment(
  urlString,
  action = "destructive database work",
  env = process.env,
) {
  return assertLocalDatabaseUrl(urlString, action, env);
}

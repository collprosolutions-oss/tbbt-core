/**
 * Safe disposable Postgres harness for dedicated verifier scripts.
 *
 * Refuses any non-local DATABASE_URL host before Prisma, psql,
 * CREATE DATABASE, db push, or DROP. Generates a unique database
 * name, wraps work in try/finally, disconnects tracked clients,
 * terminates leftover backends, and DROP DATABASE IF EXISTS WITH (FORCE).
 *
 * Cleanup runs on success, assertion failure, thrown exception,
 * and timeout / fault injection.
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export class RemoteDatabaseRefusedError extends Error {
  constructor(message, { host, action } = {}) {
    super(message);
    this.name = "RemoteDatabaseRefusedError";
    this.host = host ?? "";
    this.action = action ?? "";
  }
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

export function isLocalDatabaseHost(urlString) {
  const parsedUrl = parseDatabaseUrl(urlString);
  if (!parsedUrl) return false;
  const protocol = parsedUrl.protocol.replace(/:$/, "").toLowerCase();
  if (protocol !== "postgres" && protocol !== "postgresql") return false;
  const hostParam = (parsedUrl.searchParams.get("host") || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (hostParam) {
    return (
      LOCAL_DATABASE_HOSTS.has(hostParam) ||
      hostParam.startsWith("/")
    );
  }
  const host = (parsedUrl.hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (LOCAL_DATABASE_HOSTS.has(host)) return true;
  if (host.startsWith("/")) return true;
  return !host;
}

export function assertLocalDatabaseUrl(urlString, action = "destructive database work") {
  if (!urlString) {
    throw new RemoteDatabaseRefusedError(
      `Refusing to ${action}: DATABASE_URL is missing.`,
      { action },
    );
  }
  const parsedUrl = parseDatabaseUrl(urlString);
  if (!parsedUrl) {
    throw new RemoteDatabaseRefusedError(
      `Refusing to ${action}: DATABASE_URL is not a valid URL.`,
      { action },
    );
  }
  if (!isLocalDatabaseHost(urlString)) {
    const host =
      parsedUrl.searchParams.get("host") ||
      parsedUrl.hostname ||
      "(empty)";
    throw new RemoteDatabaseRefusedError(
      `Refusing to ${action}: DATABASE_URL host is not localhost, 127.0.0.1, ::1, or a local socket (got ${host}).`,
      { host, action },
    );
  }
  return parsedUrl;
}

export function uniqueTestDatabaseName(prefix) {
  const raw = String(prefix || "tbbt_test")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const id = randomBytes(6).toString("hex");
  return `${raw || "tbbt_test"}_${id}`;
}

export function testDatabaseUrlForName(baseUrl, testDbName) {
  const parsed = assertLocalDatabaseUrl(baseUrl, "build disposable test DATABASE_URL");
  parsed.pathname = `/${testDbName}`;
  return parsed.toString();
}

function assertSafeDatabaseName(testDbName) {
  if (!/^[a-z0-9_]+$/.test(testDbName)) {
    throw new Error(`Refusing unsafe test database name ${JSON.stringify(testDbName)}.`);
  }
  return testDbName;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

export function createRecordingOperations() {
  const log = [];
  return {
    log,
    async createDatabase({ testDbName }) {
      log.push({ op: "CREATE DATABASE", testDbName });
    },
    async pushSchema({ testUrl }) {
      log.push({ op: "prisma db push", testUrl });
    },
    createClient({ testUrl }) {
      log.push({ op: "PrismaClient", testUrl });
      return {
        $disconnect: async () => {
          log.push({ op: "$disconnect", testUrl });
        },
      };
    },
    async terminateBackends({ testDbName }) {
      log.push({ op: "pg_terminate_backend", testDbName });
    },
    async dropDatabase({ testDbName }) {
      log.push({ op: "DROP DATABASE", testDbName });
    },
    async spawnPsql() {
      log.push({ op: "psql" });
    },
  };
}

function defaultOperations() {
  const require = createRequire(import.meta.url);
  return {
    async createDatabase({ adminUrl, testDbName }) {
      assertLocalDatabaseUrl(adminUrl, "CREATE DATABASE");
      const name = assertSafeDatabaseName(testDbName);
      const { PrismaClient } = require("@prisma/client");
      const admin = new PrismaClient({ datasourceUrl: adminUrl });
      try {
        await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      } finally {
        await admin.$disconnect();
      }
    },
    async pushSchema({ testUrl }) {
      assertLocalDatabaseUrl(testUrl, "prisma db push");
      const push = spawnSync(
        "npx",
        ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
        { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
      );
      if (push.status !== 0) {
        throw new Error("Failed to push schema for disposable test database.");
      }
    },
    createClient({ testUrl }) {
      assertLocalDatabaseUrl(testUrl, "PrismaClient");
      const { PrismaClient } = require("@prisma/client");
      return new PrismaClient({ datasourceUrl: testUrl });
    },
    async terminateBackends({ adminUrl, testDbName }) {
      assertLocalDatabaseUrl(adminUrl, "pg_terminate_backend");
      const name = assertSafeDatabaseName(testDbName);
      const { PrismaClient } = require("@prisma/client");
      const admin = new PrismaClient({ datasourceUrl: adminUrl });
      try {
        try {
          await admin.$queryRawUnsafe(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
            name,
          );
        } catch {
          await admin.$executeRawUnsafe(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
          );
        }
      } finally {
        await admin.$disconnect();
      }
    },
    async dropDatabase({ adminUrl, testDbName }) {
      assertLocalDatabaseUrl(adminUrl, "DROP DATABASE");
      const name = assertSafeDatabaseName(testDbName);
      const { PrismaClient } = require("@prisma/client");
      const admin = new PrismaClient({ datasourceUrl: adminUrl });
      try {
        try {
          await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        } catch {
          await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`);
        }
      } finally {
        await admin.$disconnect();
      }
    },
  };
}

async function cleanupDisposableDatabase({
  adminUrl,
  testDbName,
  clients,
  operations,
  previousDatabaseUrl,
  restoreEnv,
}) {
  for (const client of [...clients]) {
    try {
      await client.$disconnect();
    } catch {
      /* ignore */
    }
  }
  clients.length = 0;
  if (restoreEnv) {
    if (previousDatabaseUrl == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
  if (!testDbName) return;
  try {
    await operations.terminateBackends({ adminUrl, testDbName });
  } catch {
    /* still attempt DROP */
  }
  await operations.dropDatabase({ adminUrl, testDbName });
}

/**
 * Open a unique local disposable database. Caller must cleanup().
 * Prefer withDisposableTestDatabase() so finally always runs.
 */
export async function openDisposableTestDatabase({
  databaseUrl,
  namePrefix,
  pushSchema = true,
  setProcessEnv = false,
  operations,
} = {}) {
  const adminUrl = databaseUrl;
  assertLocalDatabaseUrl(adminUrl, "CREATE DATABASE / prisma db push / DROP DATABASE");
  const ops = operations ?? defaultOperations();
  const testDbName = uniqueTestDatabaseName(namePrefix);
  const testUrl = testDatabaseUrlForName(adminUrl, testDbName);
  const clients = [];
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let created = false;

  const trackClient = (client) => {
    clients.push(client);
    return client;
  };

  const cleanup = async () => {
    await cleanupDisposableDatabase({
      adminUrl,
      testDbName: created ? testDbName : "",
      clients,
      operations: ops,
      previousDatabaseUrl,
      restoreEnv: setProcessEnv,
    });
  };

  try {
    await ops.createDatabase({ adminUrl, testUrl, testDbName });
    created = true;
    if (pushSchema) {
      await ops.pushSchema({ adminUrl, testUrl, testDbName });
    }
    if (setProcessEnv) {
      process.env.DATABASE_URL = testUrl;
    }
    const prisma = trackClient(ops.createClient({ adminUrl, testUrl, testDbName }));
    return {
      prisma,
      testUrl,
      testDbName,
      adminUrl,
      trackClient,
      createClient() {
        return trackClient(ops.createClient({ adminUrl, testUrl, testDbName }));
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function withDisposableTestDatabase(options, work) {
  const timeoutMs = options?.timeoutMs;
  const session = await openDisposableTestDatabase(options);
  try {
    const result = work(session);
    if (timeoutMs != null) {
      return await withTimeout(result, timeoutMs, "disposable test database work");
    }
    return await result;
  } finally {
    await session.cleanup();
  }
}

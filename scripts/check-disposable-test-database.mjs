/**
 * P1-12 proofs for the shared disposable-database harness.
 *
 * Run with:
 *   node scripts/check-disposable-test-database.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RemoteDatabaseRefusedError,
  assertLocalDatabaseUrl,
  createRecordingOperations,
  isLocalDatabaseHost,
  uniqueTestDatabaseName,
  withDisposableTestDatabase,
} from "./disposable-test-database.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
  }
}

const auditedScripts = [
  "scripts/check-cleaning-recurring-booking.mjs",
  "scripts/check-chief-of-staff.mjs",
  "scripts/check-estimate-versions.mjs",
  "scripts/check-password-recovery.mjs",
];

console.log("\nSTATIC — local host gate and unique names");
check("localhost is local", isLocalDatabaseHost("postgresql://u:p@localhost:5432/app"));
check("127.0.0.1 is local", isLocalDatabaseHost("postgresql://u:p@127.0.0.1:5432/app"));
check("::1 is local", isLocalDatabaseHost("postgresql://u:p@[::1]:5432/app"));
check(
  "unix socket query host is local",
  isLocalDatabaseHost("postgresql://u:p@localhost/app?host=/var/run/postgresql"),
);
check(
  "remote host is refused",
  isLocalDatabaseHost("postgresql://u:p@db.example.com:5432/prod") === false,
);
check(
  "Neon / RDS style host is refused",
  isLocalDatabaseHost("postgresql://u:p@ep-prod.us-east-1.aws.neon.tech/neondb") === false,
);
try {
  assertLocalDatabaseUrl("postgresql://u:p@db.example.com:5432/prod", "CREATE DATABASE");
  check("assertLocalDatabaseUrl throws on remote host", false);
} catch (error) {
  check(
    "assertLocalDatabaseUrl throws on remote host",
    error instanceof RemoteDatabaseRefusedError &&
      /CREATE DATABASE/.test(error.message) &&
      error.host.includes("db.example.com"),
  );
}

const first = uniqueTestDatabaseName("tbbt_harness");
const second = uniqueTestDatabaseName("tbbt_harness");
check(
  "Generated names are unique, prefixed, and identifier-safe",
  first !== second &&
    first.startsWith("tbbt_harness_") &&
    second.startsWith("tbbt_harness_") &&
    /^[a-z0-9_]+$/.test(first) &&
    /^[a-z0-9_]+$/.test(second),
);

console.log("\nSTATIC — audited verifiers import the shared harness");
const harnessSrc = read("scripts/disposable-test-database.mjs");
const defaultOpsSrc = harnessSrc.slice(
  harnessSrc.indexOf("function defaultOperations()"),
  harnessSrc.indexOf("async function cleanupDisposableDatabase"),
);
const createOpSrc = defaultOpsSrc.slice(
  defaultOpsSrc.indexOf("async createDatabase"),
  defaultOpsSrc.indexOf("async pushSchema"),
);
const pushOpSrc = defaultOpsSrc.slice(
  defaultOpsSrc.indexOf("async pushSchema"),
  defaultOpsSrc.indexOf("createClient("),
);
const clientOpSrc = defaultOpsSrc.slice(
  defaultOpsSrc.indexOf("createClient("),
  defaultOpsSrc.indexOf("async terminateBackends"),
);
const dropOpSrc = defaultOpsSrc.slice(defaultOpsSrc.indexOf("async dropDatabase"));
check(
  "Harness refuses remote hosts before default Prisma / push / DROP operations",
  harnessSrc.indexOf('assertLocalDatabaseUrl(adminUrl, "CREATE DATABASE / prisma db push / DROP DATABASE")') <
    harnessSrc.indexOf("await ops.createDatabase") &&
    createOpSrc.indexOf("assertLocalDatabaseUrl") < createOpSrc.indexOf("PrismaClient") &&
    createOpSrc.indexOf("assertLocalDatabaseUrl") < createOpSrc.indexOf("CREATE DATABASE") &&
    pushOpSrc.indexOf("assertLocalDatabaseUrl") < pushOpSrc.indexOf("db\", \"push\"") &&
    clientOpSrc.indexOf("assertLocalDatabaseUrl") < clientOpSrc.indexOf("new PrismaClient") &&
    dropOpSrc.indexOf("assertLocalDatabaseUrl") < dropOpSrc.indexOf("DROP DATABASE") &&
    harnessSrc.includes('assertLocalDatabaseUrl(adminUrl, "CREATE DATABASE")') &&
    harnessSrc.includes('assertLocalDatabaseUrl(testUrl, "prisma db push")') &&
    harnessSrc.includes('assertLocalDatabaseUrl(testUrl, "PrismaClient")') &&
    harnessSrc.includes('assertLocalDatabaseUrl(adminUrl, "pg_terminate_backend")') &&
    harnessSrc.includes('assertLocalDatabaseUrl(adminUrl, "DROP DATABASE")') &&
    harnessSrc.includes("DROP DATABASE IF EXISTS") &&
    harnessSrc.includes("WITH (FORCE)") &&
    harnessSrc.includes("pg_terminate_backend") &&
    harnessSrc.includes("} finally {") &&
    harnessSrc.includes("await session.cleanup()"),
);

for (const rel of auditedScripts) {
  const src = read(rel);
  const importAt = src.indexOf('from "./disposable-test-database.mjs"');
  const generateAt = src.indexOf('prisma", "generate"');
  const pushAt = src.indexOf('db", "push"');
  const createAt = src.indexOf("CREATE DATABASE");
  const prismaClientAt = src.indexOf("new PrismaClient");
  check(
    `${rel} imports the shared disposable harness`,
    importAt >= 0 &&
      src.includes("openDisposableTestDatabase") &&
      src.includes("assertLocalDatabaseUrl"),
  );
  check(
    `${rel} asserts the local host before generate / create / push / PrismaClient`,
    importAt >= 0 &&
      src.indexOf("assertLocalDatabaseUrl(") >= 0 &&
      (generateAt < 0 || src.indexOf("assertLocalDatabaseUrl(") < generateAt) &&
      (createAt < 0 || src.indexOf("assertLocalDatabaseUrl(") < createAt) &&
      (pushAt < 0 || src.indexOf("assertLocalDatabaseUrl(") < pushAt) &&
      (prismaClientAt < 0 || src.indexOf("assertLocalDatabaseUrl(") < prismaClientAt),
  );
  check(
    `${rel} cleans up through the harness finally path`,
    src.includes("session.cleanup()") && src.includes("} finally {"),
  );
}

console.log("\nTEST — remote URL is refused before any destructive activity");
{
  const operations = createRecordingOperations();
  let reachedWork = false;
  let refused = false;
  try {
    await withDisposableTestDatabase(
      {
        databaseUrl: "postgresql://user:secret@db.example.com:5432/production",
        namePrefix: "tbbt_harness_remote",
        operations,
      },
      async () => {
        reachedWork = true;
      },
    );
  } catch (error) {
    refused = error instanceof RemoteDatabaseRefusedError;
  }
  check("Remote URL throws RemoteDatabaseRefusedError", refused);
  check("Work callback never runs for a remote URL", reachedWork === false);
  check(
    "No Prisma, psql, CREATE DATABASE, db push, or DROP ran for a remote URL",
    operations.log.length === 0,
  );
}

console.log("\nTEST — failure, timeout, and success still drop the generated database");
{
  const operations = createRecordingOperations();
  let generatedName = "";
  let thrown = false;
  try {
    await withDisposableTestDatabase(
      {
        databaseUrl: "postgresql://user:secret@localhost:5432/postgres",
        namePrefix: "tbbt_harness_fail",
        operations,
      },
      async ({ testDbName }) => {
        generatedName = testDbName;
        throw new Error("injected assertion failure");
      },
    );
  } catch (error) {
    thrown = error instanceof Error && error.message === "injected assertion failure";
  }
  const created = operations.log.filter((entry) => entry.op === "CREATE DATABASE");
  const dropped = operations.log.filter((entry) => entry.op === "DROP DATABASE");
  const disconnected = operations.log.filter((entry) => entry.op === "$disconnect");
  const terminated = operations.log.filter((entry) => entry.op === "pg_terminate_backend");
  check("Injected failure still throws to the caller", thrown);
  check("Failure path created exactly one unique database", created.length === 1 && created[0].testDbName === generatedName);
  check(
    "Failure path disconnects, terminates backends, and drops the generated database",
    disconnected.length >= 1 &&
      terminated.length === 1 &&
      dropped.length === 1 &&
      dropped[0].testDbName === generatedName,
  );
}

{
  const operations = createRecordingOperations();
  let generatedName = "";
  let timedOut = false;
  try {
    await withDisposableTestDatabase(
      {
        databaseUrl: "postgresql://user:secret@127.0.0.1:5432/postgres",
        namePrefix: "tbbt_harness_timeout",
        timeoutMs: 25,
        operations,
      },
      async ({ testDbName }) => {
        generatedName = testDbName;
        await new Promise(() => {});
      },
    );
  } catch (error) {
    timedOut = error instanceof Error && /timed out after 25ms/.test(error.message);
  }
  const dropped = operations.log.filter((entry) => entry.op === "DROP DATABASE");
  check("Timeout / fault injection rejects the work", timedOut);
  check(
    "Timeout still drops the generated database",
    dropped.length === 1 && dropped[0].testDbName === generatedName && generatedName.startsWith("tbbt_harness_timeout_"),
  );
}

{
  const operations = createRecordingOperations();
  const result = await withDisposableTestDatabase(
    {
      databaseUrl: "postgresql://user:secret@localhost:5432/postgres",
      namePrefix: "tbbt_harness_ok",
      operations,
    },
    async ({ testDbName }) => testDbName,
  );
  const dropped = operations.log.filter((entry) => entry.op === "DROP DATABASE");
  check("Successful work still drops the generated database", dropped.length === 1 && dropped[0].testDbName === result);
}

console.log(
  failed === 0
    ? `\nAll disposable-database harness checks passed (${passed}).`
    : `\n${failed} disposable-database harness check(s) failed; ${passed} passed.`,
);
process.exit(failed === 0 ? 0 : 1);

/**
 * P1-02 — repo-wide request-path schema scanner + mutation proof.
 *
 * $executeRawUnsafe is fail-closed under src/. Historical stand-in SQL
 * that is not executed is classified, not rejected. $executeRaw /
 * $queryRaw stay classified so locks, probes, and ON CONFLICT upserts
 * remain allowed.
 *
 * Run with:
 *   node scripts/check-p1-request-path-schema-scan.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRequestPathSql } from "./production-migrate-policy.mjs";
import {
  classifyRemainingRawSql,
  scanSourceText,
  scanSrcTree,
} from "./lib/request-path-schema-scan.mjs";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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

function readRel(rel) {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

const scan = scanSrcTree(repoRoot);
const groups = classifyRemainingRawSql(scan);

console.log("\nSTATIC — current src/ has no executable request-path migration SQL");
check("Repo-wide scan finds zero executable schema DDL or backfill", scan.violations.length === 0);
check(
  "Real src/ tree has zero $executeRawUnsafe references",
  (scan.unsafeRefs ?? []).length === 0 &&
    !scan.executable.some((row) => row.method === "$executeRawUnsafe"),
);
check(
  "Historical first-run SQL is a stand-in, not an executed call",
  scan.standIns.some(
    (row) =>
      row.file === "src/lib/first-run-setup.ts" &&
      row.name === "FIRST_RUN_SETUP_ENSURE_SQL" &&
      row.schemaDdl === true &&
      row.backfillDml === true,
  ),
);
check(
  "Historical estimating CREATE TABLE is a stand-in, not an executed call",
  scan.standIns.some(
    (row) =>
      row.file === "src/lib/estimating-defaults-db.ts" &&
      row.name === "CREATE_BUSINESS_ESTIMATING_DEFAULT_TABLE_SQL" &&
      row.schemaDdl === true,
  ),
);
check(
  "Historical founder access-repair SQL is a stand-in, not an executed call",
  scan.standIns.some(
    (row) =>
      row.file === "src/lib/appointment-change-request.ts" &&
      row.name === "REPAIR_MISFILED_CHANGE_REQUEST_ACCESS_SQL" &&
      row.backfillDml === true,
  ),
);

const firstRunSrc = readRel("src/lib/first-run-setup.ts");
check(
  "A file-wide CREATE/ALTER string match would false-positive first-run stand-in SQL",
  /ALTER TABLE "Business" ADD COLUMN "firstRunSetupCompletedAt"/.test(firstRunSrc) &&
    !firstRunSrc.includes("$executeRawUnsafe") &&
    scanSourceText("src/lib/first-run-setup.ts", firstRunSrc).violations.length === 0,
);

check(
  "Legitimate advisory-lock raw SQL is classified, not rejected",
  groups["advisory-lock"].length > 0 &&
    groups["advisory-lock"].every((row) => row.violation === false) &&
    groups["advisory-lock"].some((row) => row.file.includes("schedule-reservation.ts")),
);
check(
  "Legitimate SELECT FOR UPDATE raw SQL is classified, not rejected",
  groups["row-lock"].length > 0 &&
    groups["row-lock"].every((row) => row.violation === false) &&
    groups["row-lock"].some((row) => row.file.includes("business-protection-ops.ts")),
);
check(
  "Application INSERT ON CONFLICT is classified as an upsert, not backfill",
  groups["app-upsert"].length > 0 &&
    groups["app-upsert"].every((row) => row.violation === false) &&
    groups["app-upsert"].some(
      (row) =>
        row.file.includes("chief-of-staff/controlled-actions.ts") ||
        row.file.includes("native-session-limits.ts"),
    ),
);
check(
  "Request-path presence probes stay reads",
  groups.read.some((row) => row.file === "src/lib/request-path-schema.ts") &&
    groups.read
      .filter((row) => row.file === "src/lib/request-path-schema.ts")
      .every((row) => row.violation === false),
);

console.log("\nMUTATION — restored representative DDL/backfill must fail the scan");

const mutatedFirstRun = firstRunSrc.replace(
  "ensureSchemaPromise = assertRequiredColumnsExist(db, \"Business\", [",
  "ensureSchemaPromise = db.$executeRawUnsafe(FIRST_RUN_SETUP_ENSURE_SQL).then(() => assertRequiredColumnsExist(db, \"Business\", [",
);
const mutatedFirstRunScan = scanSourceText("src/lib/first-run-setup.ts", mutatedFirstRun);
check(
  "Re-wiring FIRST_RUN_SETUP_ENSURE_SQL to $executeRawUnsafe is a violation",
  mutatedFirstRunScan.violations.length > 0 &&
    mutatedFirstRunScan.violations.some(
      (row) =>
        row.resolvedFrom === "FIRST_RUN_SETUP_ENSURE_SQL" &&
        row.schemaDdl === true &&
        row.backfillDml === true &&
        row.method === "$executeRawUnsafe",
    ),
);

const estimatingSrc = readRel("src/lib/estimating-defaults-db.ts");
const mutatedEstimating = estimatingSrc.replace(
  "ensureTablePromise = assertRequiredTablesExist(db, [",
  'ensureTablePromise = db.$executeRawUnsafe(CREATE_BUSINESS_ESTIMATING_DEFAULT_TABLE_SQL).then(() => assertRequiredTablesExist(db, [',
);
const mutatedEstimatingScan = scanSourceText(
  "src/lib/estimating-defaults-db.ts",
  mutatedEstimating,
);
check(
  "Re-wiring BusinessEstimatingDefault CREATE TABLE to $executeRawUnsafe is a violation",
  mutatedEstimatingScan.violations.some(
    (row) =>
      row.resolvedFrom === "CREATE_BUSINESS_ESTIMATING_DEFAULT_TABLE_SQL" &&
      row.schemaDdl === true &&
      row.method === "$executeRawUnsafe",
  ),
);

const repairSrc = readRel("src/lib/appointment-change-request.ts");
const mutatedRepair = repairSrc
  .replace("_db: AppointmentClient", "db: AppointmentClient")
  .replace(
    "throw new RequestPathSchemaUnavailableError(",
    "await db.$executeRawUnsafe(REPAIR_MISFILED_CHANGE_REQUEST_ACCESS_SQL);\n  throw new RequestPathSchemaUnavailableError(",
  );
const mutatedRepairScan = scanSourceText(
  "src/lib/appointment-change-request.ts",
  mutatedRepair,
);
check(
  "Restoring founder access-field repair DML is a migration-backfill violation",
  mutatedRepairScan.violations.some(
    (row) =>
      row.resolvedFrom === "REPAIR_MISFILED_CHANGE_REQUEST_ACCESS_SQL" &&
      row.backfillDml === true &&
      row.method === "$executeRawUnsafe",
  ),
);

const loopMutation = `
const ENSURE_SQL = [
  \`CREATE TABLE IF NOT EXISTS "PreviewLeak" ("id" TEXT NOT NULL)\`,
  \`ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "previewLeakAt" TIMESTAMP(3)\`,
];
export async function ensurePreviewLeakSchema(db) {
  for (const statement of ENSURE_SQL) {
    await db.$executeRawUnsafe(statement);
  }
}
`;
const loopScan = scanSourceText("src/lib/preview-leak.ts", loopMutation);
check(
  "For-of $executeRawUnsafe over a CREATE/ALTER array is a violation",
  loopScan.violations.some(
    (row) => row.resolvedFrom === "ENSURE_SQL" && row.schemaDdl === true,
  ),
);

const advisoryOnly = `
export async function lockThing(tx, key) {
  await tx.$executeRaw\`SELECT pg_advisory_xact_lock(hashtext(\${key}))\`;
}
`;
check(
  "Mutation fixture does not reject a legitimate advisory lock",
  scanSourceText("src/lib/lock-thing.ts", advisoryOnly).violations.length === 0 &&
    classifyRequestPathSql("SELECT pg_advisory_xact_lock(hashtext(?))").schemaDdl === false &&
    classifyRequestPathSql("SELECT pg_advisory_xact_lock(hashtext(?))").backfillDml === false,
);

function unsafeRejected(src) {
  const result = scanSourceText("src/lib/adversarial-bypass.ts", src);
  return result.violations.some((row) => row.method === "$executeRawUnsafe");
}

console.log("\nMUTATION — independently demonstrated $executeRawUnsafe bypasses must fail");
check(
  "Bound/alias $executeRawUnsafe is a violation",
  unsafeRejected(`
export async function ensureLeak(db) {
  const run = db.$executeRawUnsafe.bind(db);
  await run(\`CREATE TABLE IF NOT EXISTS "Leak" ("id" TEXT NOT NULL)\`);
}
`),
);
check(
  "Concatenated SQL passed to $executeRawUnsafe is a violation",
  unsafeRejected(`
export async function ensureLeak(db) {
  await db.$executeRawUnsafe(
    "CREATE" + ' TABLE IF NOT EXISTS "Leak" (id text)'
  );
}
`),
);
check(
  "Imported/renamed SQL constant passed to $executeRawUnsafe is a violation",
  unsafeRejected(`
import { HISTORICAL_SQL as q } from "./stand-in";
export async function boot(db) {
  await db.$executeRawUnsafe(q);
}
`),
);
check(
  "Helper/wrapper $executeRawUnsafe is a violation",
  unsafeRejected(`
async function applySql(db, sql) {
  await db.$executeRawUnsafe(sql);
}
export async function boot(db) {
  await applySql(
    db,
    \`CREATE TABLE IF NOT EXISTS "Leak" ("id" TEXT NOT NULL)\`
  );
}
`),
);
check(
  "Bracket-access $executeRawUnsafe is a violation",
  unsafeRejected(`
export async function ensureLeak(db) {
  await db["$executeRawUnsafe"](
    \`CREATE TABLE IF NOT EXISTS "Leak" ("id" TEXT NOT NULL)\`
  );
}
`),
);

check(
  "Single-quoted bracket access with newlines is a violation",
  unsafeRejected(`
export async function ensureLeak(db) {
  await db[
    '$executeRawUnsafe'
  ](
    \`CREATE TABLE IF NOT EXISTS "Leak" ("id" TEXT NOT NULL)\`
  );
}
`),
);
check(
  "Optional-chaining property $executeRawUnsafe is a violation",
  unsafeRejected(`
export async function ensureLeak(db) {
  await db?.$executeRawUnsafe(\`CREATE TABLE IF NOT EXISTS "Leak" ("id" TEXT NOT NULL)\`);
}
`),
);
check(
  "Optional-chaining bracket $executeRawUnsafe is a violation",
  unsafeRejected(`
export async function ensureLeak(db) {
  await db?.[
    "$executeRawUnsafe"
  ](\`CREATE TABLE IF NOT EXISTS "Leak" ("id" TEXT NOT NULL)\`);
}
`),
);
check(
  "Whitespace-split property access and bind is a violation",
  unsafeRejected(`
export async function ensureLeak(db) {
  const run = db
    .$executeRawUnsafe
    .bind(db);
  await run(\`CREATE TABLE IF NOT EXISTS "Leak" ("id" TEXT NOT NULL)\`);
}
`),
);
check(
  "Optional-chaining bind of $executeRawUnsafe is a violation",
  unsafeRejected(`
export async function ensureLeak(db) {
  const run = db.$executeRawUnsafe?.bind?.(db);
  await run(\`CREATE TABLE IF NOT EXISTS "Leak" ("id" TEXT NOT NULL)\`);
}
`),
);
check(
  "Comment mentioning $executeRawUnsafe is not a violation",
  !unsafeRejected(`
// never call $executeRawUnsafe from a request path
export async function lockThing(tx, key) {
  await tx.$executeRaw\`SELECT pg_advisory_xact_lock(hashtext(\${key}))\`;
}
`),
);
check(
  "Legitimate $executeRaw FOR UPDATE is still allowed",
  scanSourceText(
    "src/lib/lock-row.ts",
    `
export async function lockRow(tx, id) {
  await tx.$queryRaw\`SELECT id FROM "Job" WHERE id = \${id} FOR UPDATE\`;
}
`,
  ).violations.length === 0,
);
check(
  "Legitimate $executeRaw INSERT ON CONFLICT is still allowed",
  scanSourceText(
    "src/lib/upsert.ts",
    `
export async function upsert(tx) {
  await tx.$executeRaw\`INSERT INTO "Foo" ("id") VALUES ('x') ON CONFLICT ("id") DO NOTHING\`;
}
`,
  ).violations.length === 0,
);

console.log("\nCLASSIFICATION — remaining executable raw SQL under src/");
for (const [kind, rows] of Object.entries(groups)) {
  if (rows.length === 0) continue;
  console.log(`  ${kind} (${rows.length})`);
  const files = [...new Set(rows.map((row) => row.file))].sort();
  for (const file of files) {
    const sample = rows.find((row) => row.file === file);
    console.log(`    - ${file} :: ${sample.method} ${sample.sqlPreview || sample.kind}`);
  }
}

if (scan.violations.length > 0) {
  console.error("\nExecutable request-path schema/backfill violations:");
  for (const row of scan.violations) {
    console.error(`  ${row.file} ${row.method} ${row.resolvedFrom || ""} ${row.sqlPreview}`);
  }
}

console.log(
  failed === 0
    ? `\nAll P1-02 request-path schema scan checks passed (${passed}).`
    : `\n${failed} P1-02 request-path schema scan check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);

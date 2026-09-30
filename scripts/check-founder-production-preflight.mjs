/**
 * Proofs for the read-only Founder production preflight.
 *
 * Database cases use a disposable Postgres on 127.0.0.1 only.
 * They never open DATABASE_URL as the production verdict.
 *
 *   node --experimental-strip-types scripts/check-founder-production-preflight.mjs
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const {
  CERTIFICATION_SCRIPT_NAMES,
  CONVERSION_MIGRATION_NAME,
  DUPLICATE_ROOT_CONVERSION_JOBS_SQL,
  DUPLICATE_ROOT_CONVERSION_PREDICATES,
  PRODUCTION_READONLY_CONFIRM_VALUE,
  classifyDuplicateConversionGroups,
  evaluateFounderProductionPreflight,
  formatPreflightReport,
  preflightExitCode,
  productionDatabaseProbeDecision,
  sensitiveValuesFromEnv,
  snapshotPreflightEnv,
} = await import("@/lib/founder-production-preflight");
const { assertLocalDatabaseUrl } = await import("./lib/local-database-guard.mjs");
const { withDisposableTestDatabase } = await import("./disposable-test-database.mjs");
const { queryDuplicateRootConversionJobs, runProductionReadonlyProbe, withReadOnlyTransaction } =
  await import("./founder-production-preflight-db.mjs");

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

function checkThrows(label, fn) {
  try {
    fn();
    check(label, false);
  } catch {
    check(label, true);
  }
}

const STRIPE_SECRET = "sk_live_fake";
const TEST_STRIPE_SECRET = "sk_test_fake";
const WEBHOOK_SECRET = "whsec_fake";
const RESEND_SECRET = "re_fake";
const DB_PASSWORD = "preflight-db-password-sentinel";
const R2_SECRET = "r2-secret-preflight-mutation";
const CRON_SECRET = "cron-secret-preflight-mutation";
const EMAIL_FROM = "founder-preflight@example.com";
const SECRETS = [STRIPE_SECRET, TEST_STRIPE_SECRET, WEBHOOK_SECRET, RESEND_SECRET, DB_PASSWORD, R2_SECRET, CRON_SECRET];

function assertNoSecrets(text, secrets = SECRETS) {
  for (const secret of secrets) {
    if (secret && text.includes(secret)) {
      throw new Error("secret appeared in preflight output");
    }
  }
}

function assertMissingIsNotPass(report) {
  const stripe = report.checks.find((item) => item.id === "stripe_platform");
  const probe = report.checks.find((item) => item.id === "production_database_probe");
  const duplicates = report.checks.find((item) => item.id === "duplicate_root_conversion_jobs");
  if (!stripe || stripe.status === "PASS") {
    throw new Error("missing stripe treated as PASS");
  }
  if (!probe || probe.status === "PASS") {
    throw new Error("missing opt-in treated as PASS");
  }
  if (probe.status !== "MANUAL") {
    throw new Error("missing opt-in must be MANUAL VERIFICATION REQUIRED");
  }
  if (!duplicates || duplicates.status !== "MANUAL") {
    throw new Error("missing duplicate probe must stay MANUAL");
  }
}

function assertProbeDecisionIsolated(decision, env) {
  if (decision.action === "skip" || decision.action === "refuse") {
    if ("databaseUrl" in decision && decision.databaseUrl) {
      throw new Error("non-connect decision carried a database URL");
    }
    return;
  }
  if (env.TBBT_FOUNDER_PRODUCTION_READONLY_CONFIRM !== PRODUCTION_READONLY_CONFIRM_VALUE) {
    throw new Error("connected without confirmation");
  }
  if (decision.databaseUrl !== env.TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL) {
    throw new Error("connected with a URL other than the explicit read-only production URL");
  }
  if (!env.TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL) {
    throw new Error("connected without the explicit URL");
  }
  if (env.DATABASE_URL && decision.databaseUrl === env.DATABASE_URL && decision.databaseUrl !== env.TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL) {
    throw new Error("substituted DATABASE_URL");
  }
}

function mutatedDecision(env) {
  const url = env.TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL || env.DATABASE_URL;
  if (!url) return { action: "skip" };
  return { action: "connect", databaseUrl: url };
}

function extractFunction(source, name) {
  const start = source.indexOf(`export function ${name}`);
  if (start < 0) throw new Error(`missing ${name}`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

function readsFallbackDatabase(source) {
  return (
    /env\.DATABASE_URL\b/.test(source) ||
    /process\.env\.DATABASE_URL\b/.test(source) ||
    /env\[["']DATABASE_URL["']\]/.test(source) ||
    /\bDIRECT_URL\b/.test(source) ||
    /\bPOSTGRES_URL\b/.test(source) ||
    /\bPOSTGRES_PRISMA_URL\b/.test(source) ||
    /\bPGHOST\b/.test(source)
  );
}

function certificationMap(present = true) {
  return Object.fromEntries(CERTIFICATION_SCRIPT_NAMES.map((name) => [name, present]));
}

function evaluate(env, extra = {}) {
  return evaluateFounderProductionPreflight({
    env: snapshotPreflightEnv(env),
    conversionMigration: { present: true, guardsDuplicates: true },
    certificationScriptsPresent: certificationMap(true),
    migrateOwner: { run: false, reason: "local build" },
    probe: null,
    migrationPlan: null,
    ...extra,
    env: snapshotPreflightEnv(env),
  });
}

function emptyProbeCounts() {
  return {
    publishedBusinessCount: null,
    businessCount: null,
    verifiedDomainCount: null,
    unverifiedDomainCount: null,
    failedDomainCount: null,
    smsAssignedCount: null,
  };
}

const libSrc = read("src/lib/founder-production-preflight.ts");
const dbSrc = read("scripts/founder-production-preflight-db.mjs");
const cliSrc = read("scripts/founder-production-preflight.mjs");
const proxySrc = read("src/proxy.ts");
const cronSrc = read("src/lib/marketing-studio-reminder.ts");
const packageJson = JSON.parse(read("package.json"));
const migrationSql = read(`prisma/migrations/${CONVERSION_MIGRATION_NAME}/migration.sql`);

console.log("\nSTATIC — checker stays read-only and does not borrow another database");
const resolver = extractFunction(libSrc, "resolveProductionReadonlyDatabaseTarget");
const decisionFn = extractFunction(libSrc, "productionDatabaseProbeDecision");
check("resolver ignores fallback database env", !readsFallbackDatabase(resolver));
check("decision ignores fallback database env", !readsFallbackDatabase(decisionFn));
check(
  "DATABASE_URL fallback mutation fails the source guard",
  readsFallbackDatabase(
    resolver.replace(
      'return { authorized: false, databaseUrl: "" };',
      'return { authorized: true, databaseUrl: env.DATABASE_URL || "" };',
    ),
  ),
);
check("probe module does not read process.env", !/process\.env/.test(dbSrc));
check("probe sets a read-only transaction", dbSrc.includes("SET TRANSACTION READ ONLY"));
check("probe does not repair rows", !/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/.test(dbSrc));
check("cli connects only from the authorized branch", /if \(decision\.action === "connect"\)/.test(cliSrc));
check(
  "cli does not deploy, build, or migrate",
  !cliSrc.includes("migrate deploy") && !cliSrc.includes("npm run build") && !cliSrc.includes("prisma migrate"),
);
check("library does not repair Job rows", !libSrc.includes("DELETE FROM") && !libSrc.includes('UPDATE "Job"'));
check("proxy still allows public site and webhook paths", proxySrc.includes("isStripeWebhookPath") && proxySrc.includes("isCustomerMessagingWebhookPath") && proxySrc.includes("isPublicWebsitePath"));
check("cron authorization still fails closed without a secret", cronSrc.includes("if (!secret) return false"));
check("npm preflight script is present", packageJson.scripts["preflight:founder"]?.includes("scripts/founder-production-preflight.mjs") === true);
check("npm test script is present", packageJson.scripts["test:founder-production-preflight"]?.includes("scripts/check-founder-production-preflight.mjs") === true);
check("build does not run the preflight", !packageJson.scripts.build.includes("preflight"));
for (const predicate of DUPLICATE_ROOT_CONVERSION_PREDICATES) {
  check(`query keeps ${predicate}`, DUPLICATE_ROOT_CONVERSION_JOBS_SQL.includes(predicate));
  check(`migration keeps ${predicate}`, migrationSql.includes(predicate));
}
check("migration still raises before creating the unique index", migrationSql.includes("HAVING COUNT(*) > 1") && migrationSql.includes("RAISE EXCEPTION"));

console.log("\nCLASSIFICATION — secrets, missing opt-in, and statuses");
const emptyReport = evaluate({});
assertMissingIsNotPass(emptyReport);
check("empty environment does not pass required gaps", true);
const emptyText = formatPreflightReport(emptyReport);
check("empty duplicate gate is manual", emptyReport.checks.find((item) => item.id === "duplicate_root_conversion_jobs")?.status === "MANUAL");
check("empty stripe is missing", emptyReport.checks.find((item) => item.id === "stripe_platform")?.status === "MISSING");
check("empty email is missing", emptyReport.checks.find((item) => item.id === "email_provider")?.status === "MISSING");
check("empty r2 is missing", emptyReport.checks.find((item) => item.id === "r2_platform")?.status === "MISSING");
check("empty app url is missing", emptyReport.checks.find((item) => item.id === "public_app_url")?.status === "MISSING");
check("recorded certification stays manual", emptyReport.checks.find((item) => item.id === "certification_recorded_green")?.status === "MANUAL");
check("certification commands are listed", emptyReport.checks.find((item) => item.id === "certification_recorded_green")?.detail.includes("npm run test:production-certification") === true);
check("public routes pass from existing helpers", emptyReport.checks.find((item) => item.id === "public_website_routes")?.status === "PASS");
check("launch clearance is not clear without production config", emptyReport.launchClearance === "NOT_CLEAR");
check("exit code is 1 when nothing is blocked", preflightExitCode(emptyReport) === 1);
check("formatted empty report has the manual label", emptyText.includes("[MANUAL VERIFICATION REQUIRED] Production database read-only probe"));

const decoyUrl = `postgresql://user:${DB_PASSWORD}@127.0.0.1:5432/decoy`;
const substituted = evaluate(
  { DATABASE_URL: decoyUrl },
  {
    probe: {
      connectivity: "ok",
      failureDetail: null,
      duplicateGroups: [{ estimateId: "est_substituted", duplicateCount: 2, jobIds: ["job_a", "job_b"] }],
      ...emptyProbeCounts(),
      publishedBusinessCount: 3,
      businessCount: 3,
      verifiedDomainCount: 1,
      smsAssignedCount: 4,
    },
  },
);
const substitutedDuplicate = substituted.checks.find((item) => item.id === "duplicate_root_conversion_jobs");
check("substituted probe is not the production verdict", substitutedDuplicate?.status === "MANUAL");
check("substituted duplicate ids are not reported", !JSON.stringify(substituted).includes("est_substituted"));
check("substituted publish count is not a pass", substituted.checks.find((item) => item.id === "website_publish")?.status === "MANUAL");
assertNoSecrets(formatPreflightReport(substituted, { sensitiveValues: sensitiveValuesFromEnv({ DATABASE_URL: decoyUrl }) }));
check("decoy database password stays out of the report", true);

const configured = {
  STRIPE_SECRET_KEY: STRIPE_SECRET,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_SAAS_PRICE_ID: "price_founder_preflight",
  NEXT_PUBLIC_APP_URL: "https://www.collproreno.com",
  RESEND_API_KEY: RESEND_SECRET,
  EMAIL_FROM,
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "access-key-preflight",
  R2_SECRET_ACCESS_KEY: R2_SECRET,
  R2_BUCKET_NAME: "bucket",
  CRON_SECRET,
  DATABASE_URL: decoyUrl,
};
const configuredReport = evaluate(configured);
const configuredText = formatPreflightReport(configuredReport, {
  sensitiveValues: sensitiveValuesFromEnv(configured),
});
assertNoSecrets(JSON.stringify(configuredReport));
assertNoSecrets(configuredText);
check("configured report omits secret values", true);
check("live stripe key passes without printing it", configuredReport.checks.find((item) => item.id === "stripe_platform")?.status === "PASS");
check("saas configuration passes", configuredReport.checks.find((item) => item.id === "saas_billing")?.status === "PASS");
check("founder price amount stays manual", configuredReport.checks.find((item) => item.id === "founder_price_amount")?.status === "MANUAL");
check("canonical app url passes", configuredReport.checks.find((item) => item.id === "public_app_url")?.status === "PASS");
check("email passes", configuredReport.checks.find((item) => item.id === "email_provider")?.status === "PASS");
check("r2 passes", configuredReport.checks.find((item) => item.id === "r2_platform")?.status === "PASS");
check("r2 cors stays manual", configuredReport.checks.find((item) => item.id === "r2_cors")?.status === "MANUAL");
check("webhook secret passes", configuredReport.checks.find((item) => item.id === "stripe_webhook")?.status === "PASS");
check("runtime database host is reported without the password", configuredReport.checks.find((item) => item.id === "runtime_database_url")?.detail.includes("host 127.0.0.1") === true);
check("connect merchant stays manual", configuredReport.checks.find((item) => item.id === "stripe_connect_merchant")?.status === "MANUAL");
check("sms stays optional missing", configuredReport.checks.find((item) => item.id === "sms_twilio")?.status === "MISSING");
check("optional sms missing does not block by itself", configuredReport.checks.find((item) => item.id === "sms_twilio")?.blocksLaunch === false);

const testKeyReport = evaluate({ ...configured, STRIPE_SECRET_KEY: TEST_STRIPE_SECRET });
check("test stripe key is blocked", testKeyReport.checks.find((item) => item.id === "stripe_platform")?.status === "BLOCKED");
assertNoSecrets(formatPreflightReport(testKeyReport, { sensitiveValues: sensitiveValuesFromEnv({ STRIPE_SECRET_KEY: TEST_STRIPE_SECRET }) }));
check("test stripe key value is omitted", true);
check("blocked report exits 2", preflightExitCode(testKeyReport) === 2);

const fakeReport = evaluate({ ...configured, TBBT_PAYMENTS_ADAPTER: "fake", TBBT_SAAS_BILLING_ADAPTER: "fake" });
check("fake payment adapter is blocked", fakeReport.checks.find((item) => item.id === "stripe_platform")?.status === "BLOCKED");
check("fake saas adapter is blocked", fakeReport.checks.find((item) => item.id === "saas_billing")?.status === "BLOCKED");

const localhostUrl = evaluate({ NEXT_PUBLIC_APP_URL: "http://127.0.0.1:43217" });
check("localhost app url is blocked", localhostUrl.checks.find((item) => item.id === "public_app_url")?.status === "BLOCKED");
check("localhost app url value is omitted", !formatPreflightReport(localhostUrl).includes("43217"));

const fromOnly = evaluate({
  TWILIO_ACCOUNT_SID: "ACpreflightmutationproof00000001",
  TWILIO_AUTH_TOKEN: "twilio-token-preflight-mutation",
  TWILIO_FROM_NUMBER: "+15555550123",
});
check("shared from-number sms is blocked", fromOnly.checks.find((item) => item.id === "sms_twilio")?.status === "BLOCKED");
assertNoSecrets(formatPreflightReport(fromOnly, {
  sensitiveValues: ["ACpreflightmutationproof00000001", "twilio-token-preflight-mutation", "+15555550123"],
}));
check("twilio token is omitted", true);

const httpBase = evaluate({ ...configured, STORAGE_PUBLIC_BASE_URL: "http://cdn.example.test/files" });
check("non-https public storage base is blocked", httpBase.checks.find((item) => item.id === "storage_public_base_url")?.status === "BLOCKED");
check("public storage base value is omitted", !formatPreflightReport(httpBase).includes("cdn.example.test"));

console.log("\nMUTATION — bad checkers fail the same assertions");
checkThrows("printing a secret fails the output assertion", () => {
  assertNoSecrets(`${configuredText}\n${STRIPE_SECRET}`);
});
checkThrows("treating missing env as PASS fails", () => {
  assertMissingIsNotPass({
    ...emptyReport,
    checks: emptyReport.checks.map((item) => ({ ...item, status: "PASS", blocksLaunch: false })),
  });
});
const fallbackEnv = snapshotPreflightEnv({ DATABASE_URL: decoyUrl });
checkThrows("substituting DATABASE_URL fails the decision assertion", () => {
  assertProbeDecisionIsolated(mutatedDecision(fallbackEnv), fallbackEnv);
});
const isolated = productionDatabaseProbeDecision(fallbackEnv);
assertProbeDecisionIsolated(isolated, fallbackEnv);
check("real decision skips when only DATABASE_URL is set", isolated.action === "skip");

const explicitEnv = snapshotPreflightEnv({
  DATABASE_URL: decoyUrl,
  TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL: "postgresql://reader:other-secret@127.0.0.1:5432/explicit",
  TBBT_FOUNDER_PRODUCTION_READONLY_CONFIRM: PRODUCTION_READONLY_CONFIRM_VALUE,
});
const explicitDecision = productionDatabaseProbeDecision(explicitEnv);
assertProbeDecisionIsolated(explicitDecision, explicitEnv);
check("explicit opt-in uses only that URL", explicitDecision.action === "connect" && explicitDecision.databaseUrl.endsWith("/explicit"));
const explicitReport = formatPreflightReport(evaluate({
  DATABASE_URL: decoyUrl,
  TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL: "postgresql://reader:other-secret@127.0.0.1:5432/explicit",
  TBBT_FOUNDER_PRODUCTION_READONLY_CONFIRM: PRODUCTION_READONLY_CONFIRM_VALUE,
}), { sensitiveValues: ["other-secret", DB_PASSWORD] });
assertNoSecrets(explicitReport, ["other-secret", DB_PASSWORD]);
check("explicit URL password is omitted from the report", true);

const refused = productionDatabaseProbeDecision(snapshotPreflightEnv({
  DATABASE_URL: decoyUrl,
  TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL: "https://example.com/not-postgres",
  TBBT_FOUNDER_PRODUCTION_READONLY_CONFIRM: PRODUCTION_READONLY_CONFIRM_VALUE,
}));
check("non-postgres opt-in is refused before connect", refused.action === "refuse");
const refusedReport = evaluate({
  DATABASE_URL: decoyUrl,
  TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL: "https://example.com/not-postgres",
  TBBT_FOUNDER_PRODUCTION_READONLY_CONFIRM: PRODUCTION_READONLY_CONFIRM_VALUE,
});
check("refused URL blocks the probe", refusedReport.checks.find((item) => item.id === "production_database_probe")?.status === "BLOCKED");
check("refused URL does not echo the raw value", !formatPreflightReport(refusedReport).includes("example.com/not-postgres"));

const zero = classifyDuplicateConversionGroups([]);
check("zero duplicate groups pass", zero.status === "PASS" && zero.evidence.length === 0);
const blockedGroups = classifyDuplicateConversionGroups([
  { estimateId: "est_dup", duplicateCount: 2, jobIds: ["job_root_a", "job_root_b"] },
]);
check("duplicate groups block with ids and count", blockedGroups.status === "BLOCKED" && blockedGroups.detail.includes("est_dup") && blockedGroups.detail.includes("count 2") && blockedGroups.detail.includes("job_root_a") && blockedGroups.detail.includes("job_root_b"));

const optedProbe = evaluate(
  {
    TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL: "postgresql://reader:hidden-probe-secret@127.0.0.1:5432/explicit",
    TBBT_FOUNDER_PRODUCTION_READONLY_CONFIRM: PRODUCTION_READONLY_CONFIRM_VALUE,
  },
  {
    probe: {
      connectivity: "ok",
      failureDetail: null,
      duplicateGroups: [{ estimateId: "est_dup", duplicateCount: 2, jobIds: ["job_root_a", "job_root_b"] }],
      ...emptyProbeCounts(),
    },
    migrationPlan: { blocked: false, reason: `pending migrations: ${CONVERSION_MIGRATION_NAME}` },
  },
);
const optedDuplicate = optedProbe.checks.find((item) => item.id === "duplicate_root_conversion_jobs");
check("authorized duplicate rows are blocked", optedDuplicate?.status === "BLOCKED");
check("authorized duplicate evidence keeps ids", optedDuplicate?.evidence?.[0]?.duplicateCount === 2 && optedDuplicate.evidence[0].jobIds.join(",") === "job_root_a,job_root_b");
check("pending conversion migration is blocked while duplicates exist", optedProbe.checks.find((item) => item.id === "migration_history")?.status === "BLOCKED");
assertNoSecrets(formatPreflightReport(optedProbe, { sensitiveValues: ["hidden-probe-secret"] }), ["hidden-probe-secret"]);
check("probe password is omitted", true);

const cleanProbe = evaluate(
  {
    TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL: "postgresql://reader@127.0.0.1:5432/explicit",
    TBBT_FOUNDER_PRODUCTION_READONLY_CONFIRM: PRODUCTION_READONLY_CONFIRM_VALUE,
  },
  {
    probe: {
      connectivity: "ok",
      failureDetail: null,
      duplicateGroups: [],
      ...emptyProbeCounts(),
    },
    migrationPlan: { blocked: false, reason: "no pending migrations" },
  },
);
check("authorized zero duplicates pass", cleanProbe.checks.find((item) => item.id === "duplicate_root_conversion_jobs")?.status === "PASS");
check("current migration history passes when nothing is pending", cleanProbe.checks.find((item) => item.id === "migration_history")?.status === "PASS");

const productionOwner = evaluate(
  { VERCEL_ENV: "production", VERCEL_PROJECT_NAME: "workspace" },
  { migrateOwner: { run: false, reason: "not the migrate-owner Vercel project" } },
);
check("production on the wrong project blocks migrate ownership", productionOwner.checks.find((item) => item.id === "production_migrate_owner")?.status === "BLOCKED");

console.log("\nCLI — does not print secrets or open DATABASE_URL");
const child = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "scripts/founder-production-preflight.mjs"],
  {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      STRIPE_SECRET_KEY: STRIPE_SECRET,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      RESEND_API_KEY: RESEND_SECRET,
      DATABASE_URL: decoyUrl,
    },
  },
);
const cliOutput = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
check("cli exits without a production clearance", child.status === 1);
assertNoSecrets(cliOutput);
check("cli output omits secrets", true);
check("cli keeps the production probe manual", cliOutput.includes("[MANUAL VERIFICATION REQUIRED] Production database read-only probe"));
check("cli does not block duplicates from DATABASE_URL", !cliOutput.includes("[BLOCKED] Duplicate root conversion jobs"));

console.log("\nDB — disposable 127.0.0.1 Postgres");
const adminUrl = "postgresql://tbbt_preflight@127.0.0.1:5432/tbbt_preflight";
const adminHost = new URL(adminUrl).hostname;
check("admin url is 127.0.0.1", adminHost === "127.0.0.1");
assertLocalDatabaseUrl(adminUrl, "founder preflight disposable database");

await withDisposableTestDatabase(
  {
    databaseUrl: adminUrl,
    namePrefix: "founder_preflight",
    pushSchema: false,
  },
  async ({ prisma, testUrl }) => {
    const host = new URL(testUrl).hostname;
    if (host !== "127.0.0.1") {
      throw new Error(`Refusing founder preflight test database host ${host}`);
    }
    assertLocalDatabaseUrl(testUrl, "founder preflight duplicate query");
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "Job" (
        id TEXT PRIMARY KEY,
        "estimateId" TEXT,
        "recurrenceSourceJobId" TEXT,
        "nextBookingSourceJobId" TEXT,
        "correctiveCleanSourceJobId" TEXT
      )
    `);
    const none = await queryDuplicateRootConversionJobs(testUrl);
    check("zero rows pass the duplicate query", none.length === 0 && classifyDuplicateConversionGroups(none).status === "PASS");

    await prisma.$executeRawUnsafe(`
      INSERT INTO "Job" (id, "estimateId", "recurrenceSourceJobId", "nextBookingSourceJobId", "correctiveCleanSourceJobId")
      VALUES
        ('job_root_a', 'est_dup', NULL, NULL, NULL),
        ('job_root_b', 'est_dup', NULL, NULL, NULL),
        ('job_recur', 'est_dup', 'job_root_a', NULL, NULL),
        ('job_next', 'est_dup', NULL, 'job_root_a', NULL),
        ('job_corr', 'est_dup', NULL, NULL, 'job_root_a'),
        ('job_ok', 'est_single', NULL, NULL, NULL),
        ('job_none', NULL, NULL, NULL, NULL)
    `);
    const groups = await queryDuplicateRootConversionJobs(testUrl);
    check(
      "duplicate roots are blocked with estimate id, count, and job ids",
      groups.length === 1 &&
        groups[0].estimateId === "est_dup" &&
        groups[0].duplicateCount === 2 &&
        groups[0].jobIds.join(",") === "job_root_a,job_root_b",
    );
    check("child jobs and null estimates are excluded", !JSON.stringify(groups).includes("job_recur") && !JSON.stringify(groups).includes("job_ok") && !JSON.stringify(groups).includes("est_single"));

    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = testUrl;
    let emptyArgument = "called";
    try {
      emptyArgument = await queryDuplicateRootConversionJobs("");
    } catch {
      emptyArgument = "threw";
    } finally {
      if (previousDatabaseUrl == null) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
    check("empty probe URL does not fall back to DATABASE_URL", emptyArgument === "threw");

    let readOnlyRejected = false;
    try {
      await withReadOnlyTransaction(testUrl, async (tx) => {
        await tx.$executeRawUnsafe(`INSERT INTO "Job" (id) VALUES ('preflight_should_not_write')`);
      });
    } catch (error) {
      const message = String(error?.message || error);
      readOnlyRejected = /read-only/i.test(message) || message.includes("25006");
    }
    const leftover = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "Job" WHERE id = 'preflight_should_not_write'`,
    );
    check("read-only transaction rejects INSERT", readOnlyRejected && Number(leftover[0]?.n) === 0);

    const before = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "Job"`);
    const probed = await runProductionReadonlyProbe(testUrl);
    const after = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "Job"`);
    check("full probe reads duplicates and does not change rows", probed.probe.connectivity === "ok" && probed.probe.duplicateGroups.length === 1 && Number(before[0]?.n) === Number(after[0]?.n));
    check("missing business tables stay uncounted", probed.probe.publishedBusinessCount == null && probed.probe.smsAssignedCount == null);
    check("missing migration history is reported without a write", probed.migration.queryError === true && probed.migration.tableMissing === true);
  },
);

console.log(
  failed === 0
    ? `\nAll Founder production preflight checks passed (${passed}).`
    : `\n${failed} Founder production preflight check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);

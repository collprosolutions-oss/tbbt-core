/**
 * Explicit read-only production probe for the Founder preflight.
 *
 * Opens only the URL argument. Does not read the process environment. Every query
 * runs inside a transaction after SET TRANSACTION READ ONLY.
 * Statements that change rows are not issued.
 */
import { createRequire } from "node:module";
import { extractPostgresSqlState } from "./production-migrate-policy.mjs";

const require = createRequire(import.meta.url);

const MIGRATION_HISTORY_SQL = `
SELECT "migration_name", "checksum", "finished_at", "rolled_back_at"
FROM "_prisma_migrations"
`;

const USER_TABLE_COUNT_SQL = `
SELECT COUNT(*)::int AS n
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
  AND table_name <> '_prisma_migrations'
`;

const WEBSITE_PUBLISH_SQL = `
SELECT COUNT(*)::int AS "businesses",
       COUNT("publishedWebsiteId")::int AS "published"
FROM "Business"
`;

const DOMAIN_SQL = `
SELECT status, COUNT(*)::int AS "count"
FROM "WebsiteHostBinding"
GROUP BY status
`;

const SMS_NUMBER_SQL = `
SELECT COUNT("operationalSmsNumber")::int AS "assigned"
FROM "Business"
`;

function redactConnectionError(error) {
  const message = error instanceof Error ? error.message : "connection failed";
  return message
    .replace(/\b(?:postgres|postgresql):\/\/[^\s]+/gi, "postgresql://[redacted]")
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/\brk_(?:live|test)_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/\bwhsec_[A-Za-z0-9_]+/g, "[redacted]");
}

function assertExplicitUrl(databaseUrl) {
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    throw new Error("Refusing database probe without an explicit URL argument.");
  }
}

async function loadPreflight() {
  return import("@/lib/founder-production-preflight");
}

export async function withReadOnlyTransaction(databaseUrl, fn) {
  assertExplicitUrl(databaseUrl);
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return fn(tx);
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function readOnlyRows(databaseUrl, sql) {
  try {
    const rows = await withReadOnlyTransaction(databaseUrl, (tx) => tx.$queryRawUnsafe(sql));
    return { ok: true, rows };
  } catch (error) {
    return {
      ok: false,
      code: extractPostgresSqlState(error) || null,
      detail: redactConnectionError(error),
    };
  }
}

function domainCounts(rows) {
  const counts = { verified: 0, unverified: 0, failed: 0 };
  if (!Array.isArray(rows)) return counts;
  for (const row of rows) {
    const status = String(row?.status ?? "").toUpperCase();
    const count = Number(row?.count ?? 0);
    if (!Number.isFinite(count)) continue;
    if (status === "VERIFIED") counts.verified += count;
    else if (status === "FAILED") counts.failed += count;
    else counts.unverified += count;
  }
  return counts;
}

export async function queryDuplicateRootConversionJobs(databaseUrl) {
  const { DUPLICATE_ROOT_CONVERSION_JOBS_SQL, normalizeDuplicateGroups } = await loadPreflight();
  const rows = await withReadOnlyTransaction(databaseUrl, (tx) =>
    tx.$queryRawUnsafe(DUPLICATE_ROOT_CONVERSION_JOBS_SQL),
  );
  return normalizeDuplicateGroups(rows);
}

export async function runProductionReadonlyProbe(databaseUrl) {
  assertExplicitUrl(databaseUrl);
  const { DUPLICATE_ROOT_CONVERSION_JOBS_SQL, normalizeDuplicateGroups } = await loadPreflight();
  const duplicates = await readOnlyRows(databaseUrl, DUPLICATE_ROOT_CONVERSION_JOBS_SQL);
  if (!duplicates.ok) {
    return {
      probe: {
        connectivity: "failed",
        failureDetail: duplicates.detail,
        duplicateGroups: [],
        publishedBusinessCount: null,
        businessCount: null,
        verifiedDomainCount: null,
        unverifiedDomainCount: null,
        failedDomainCount: null,
        smsAssignedCount: null,
      },
      migration: {
        rows: null,
        queryError: true,
        queryCode: duplicates.code,
        tableMissing: false,
        userTableCount: null,
      },
    };
  }

  const migration = await readOnlyRows(databaseUrl, MIGRATION_HISTORY_SQL);
  const userTables = await readOnlyRows(databaseUrl, USER_TABLE_COUNT_SQL);
  const website = await readOnlyRows(databaseUrl, WEBSITE_PUBLISH_SQL);
  const domains = await readOnlyRows(databaseUrl, DOMAIN_SQL);
  const sms = await readOnlyRows(databaseUrl, SMS_NUMBER_SQL);
  const domain = domains.ok ? domainCounts(domains.rows) : null;
  const websiteRow = website.ok ? website.rows?.[0] : null;
  const smsRow = sms.ok ? sms.rows?.[0] : null;

  return {
    probe: {
      connectivity: "ok",
      failureDetail: null,
      duplicateGroups: normalizeDuplicateGroups(duplicates.rows),
      publishedBusinessCount: websiteRow ? Number(websiteRow.published ?? 0) : null,
      businessCount: websiteRow ? Number(websiteRow.businesses ?? 0) : null,
      verifiedDomainCount: domain ? domain.verified : null,
      unverifiedDomainCount: domain ? domain.unverified : null,
      failedDomainCount: domain ? domain.failed : null,
      smsAssignedCount: smsRow ? Number(smsRow.assigned ?? 0) : null,
    },
    migration: {
      rows: migration.ok ? migration.rows : null,
      queryError: !migration.ok,
      queryCode: migration.ok ? null : migration.code,
      tableMissing: !migration.ok && migration.code === "42P01",
      userTableCount: userTables.ok ? Number(userTables.rows?.[0]?.n ?? 0) : null,
    },
  };
}

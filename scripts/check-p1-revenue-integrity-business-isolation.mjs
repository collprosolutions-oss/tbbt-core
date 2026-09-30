/**
 * P1-03 — Revenue-integrity backfill must not cross-attach financial
 * records between businesses. The already-applied migration is left
 * unchanged; this check exercises the forward corrective path.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-p1-revenue-integrity-business-isolation.mjs
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

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

function sqlStatements(sql) {
  return String(sql)
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

const VULNERABLE_CHANGE_ORDER_SQL = `
UPDATE "ChangeOrder" AS co
SET "invoiceId" = first_invoice.id
FROM (
  SELECT DISTINCT ON ("jobId") id, "jobId", "createdAt"
  FROM "Invoice"
  WHERE "jobId" IS NOT NULL AND "kind" = 'ORIGINAL'
  ORDER BY "jobId", "createdAt" ASC, id ASC
) AS first_invoice
WHERE co."jobId" = first_invoice."jobId"
  AND co.status = 'APPROVED'
  AND co."invoiceId" IS NULL
  AND co."approvedAt" IS NOT NULL
  AND co."approvedAt" <= first_invoice."createdAt"
`.trim();

const VULNERABLE_PAYMENT_JOB_SQL = `
UPDATE "Payment" AS p
SET "invoiceId" = original.id
FROM (
  SELECT DISTINCT ON ("jobId") id, "jobId"
  FROM "Invoice"
  WHERE "jobId" IS NOT NULL AND "kind" = 'ORIGINAL'
  ORDER BY "jobId", "createdAt" ASC, id ASC
) AS original
WHERE p."invoiceId" IS NULL
  AND p."jobId" IS NOT NULL
  AND p."jobId" = original."jobId"
`.trim();

const VULNERABLE_PAYMENT_ESTIMATE_SQL = `
UPDATE "Payment" AS p
SET "invoiceId" = original.id,
    "jobId" = COALESCE(p."jobId", j.id)
FROM "Job" AS j
INNER JOIN "Invoice" AS original
  ON original."jobId" = j.id
 AND original."kind" = 'ORIGINAL'
WHERE p."invoiceId" IS NULL
  AND p."estimateId" IS NOT NULL
  AND j."estimateId" IS NOT NULL
  AND p."estimateId" = j."estimateId"
`.trim();

const originalMigration = readRepo(
  "prisma/migrations/20260926100000_revenue_integrity_supplemental_invoices/migration.sql",
);
const correctiveMigration = readRepo(
  "prisma/migrations/20260929233000_revenue_integrity_business_isolation/migration.sql",
);

console.log("\nSTATIC — original migration stays applied; correction is forward-only");
check(
  "Original migration still joins ChangeOrder/Payment without businessId equality",
  originalMigration.includes(VULNERABLE_CHANGE_ORDER_SQL) &&
    originalMigration.includes(VULNERABLE_PAYMENT_JOB_SQL) &&
    originalMigration.includes(VULNERABLE_PAYMENT_ESTIMATE_SQL) &&
    !originalMigration.includes('co."businessId" = first_invoice."businessId"'),
);
check(
  "Corrective migration requires business-equality and detects historical mismatches",
  correctiveMigration.includes('AND co."businessId" = first_invoice."businessId"') &&
    correctiveMigration.includes('AND p."businessId" = original."businessId"') &&
    correctiveMigration.includes('AND p."businessId" = j."businessId"') &&
    correctiveMigration.includes("RevenueIntegrityBusinessIsolationFinding") &&
    correctiveMigration.includes("change_order_attached_foreign_invoice") &&
    correctiveMigration.includes("payment_attached_foreign_invoice") &&
    correctiveMigration.includes("Do not edit that already-applied migration"),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "P1-03 revenue-integrity disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_p1_rev_iso",
});
const prisma = session.prisma;

async function seedBusiness(name) {
  return prisma.business.create({
    data: {
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
}

async function seedLegacyRows() {
  const businessA = await seedBusiness("Alpha Isolation");
  const businessB = await seedBusiness("Beta Isolation");
  const estimateA = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      status: "APPROVED",
      total: "100",
      publicToken: randomUUID(),
    },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      estimateId: estimateA.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
    },
  });
  const jobB = await prisma.job.create({
    data: {
      businessId: businessB.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
    },
  });
  const invoiceA = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      kind: "ORIGINAL",
      status: "SENT",
      total: "100",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    },
  });
  const invoiceB = await prisma.invoice.create({
    data: {
      businessId: businessB.id,
      jobId: jobB.id,
      kind: "ORIGINAL",
      status: "SENT",
      total: "50",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    },
  });
  const approvedAt = new Date("2026-01-01T00:00:00.000Z");
  const validChangeOrder = await prisma.changeOrder.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      title: "Same-business approved CO",
      status: "APPROVED",
      total: "25",
      approvedAt,
      sentAt: approvedAt,
    },
  });
  const foreignChangeOrder = await prisma.changeOrder.create({
    data: {
      businessId: businessB.id,
      jobId: jobA.id,
      title: "Cross-business CO pointing at A job",
      status: "APPROVED",
      total: "25",
      approvedAt,
      sentAt: approvedAt,
    },
  });
  const alreadyAttachedForeignChangeOrder = await prisma.changeOrder.create({
    data: {
      businessId: businessB.id,
      jobId: jobA.id,
      title: "Already attached foreign CO",
      status: "APPROVED",
      total: "10",
      approvedAt,
      sentAt: approvedAt,
      invoiceId: invoiceA.id,
    },
  });
  const validJobPayment = await prisma.payment.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      purpose: "INVOICE_BALANCE",
      amount: "10",
      method: "CASH",
    },
  });
  const foreignJobPayment = await prisma.payment.create({
    data: {
      businessId: businessB.id,
      jobId: jobA.id,
      purpose: "INVOICE_BALANCE",
      amount: "11",
      method: "CASH",
    },
  });
  const validEstimatePayment = await prisma.payment.create({
    data: {
      businessId: businessA.id,
      estimateId: estimateA.id,
      purpose: "MATERIAL_DEPOSIT",
      amount: "12",
      method: "CASH",
    },
  });
  const foreignEstimatePayment = await prisma.payment.create({
    data: {
      businessId: businessB.id,
      estimateId: estimateA.id,
      purpose: "MATERIAL_DEPOSIT",
      amount: "13",
      method: "CASH",
    },
  });
  const alreadyAttachedForeignPayment = await prisma.payment.create({
    data: {
      businessId: businessB.id,
      jobId: jobA.id,
      invoiceId: invoiceA.id,
      purpose: "INVOICE_BALANCE",
      amount: "14",
      method: "CASH",
    },
  });
  return {
    businessA,
    businessB,
    jobA,
    jobB,
    invoiceA,
    invoiceB,
    validChangeOrder,
    foreignChangeOrder,
    alreadyAttachedForeignChangeOrder,
    validJobPayment,
    foreignJobPayment,
    validEstimatePayment,
    foreignEstimatePayment,
    alreadyAttachedForeignPayment,
  };
}

async function reload(seed) {
  const ids = [
    seed.validChangeOrder.id,
    seed.foreignChangeOrder.id,
    seed.alreadyAttachedForeignChangeOrder.id,
  ];
  const changeOrders = await prisma.changeOrder.findMany({ where: { id: { in: ids } } });
  const payments = await prisma.payment.findMany({
    where: {
      id: {
        in: [
          seed.validJobPayment.id,
          seed.foreignJobPayment.id,
          seed.validEstimatePayment.id,
          seed.foreignEstimatePayment.id,
          seed.alreadyAttachedForeignPayment.id,
        ],
      },
    },
  });
  const byId = Object.fromEntries(
    [...changeOrders, ...payments].map((row) => [row.id, row]),
  );
  return {
    validChangeOrder: byId[seed.validChangeOrder.id],
    foreignChangeOrder: byId[seed.foreignChangeOrder.id],
    alreadyAttachedForeignChangeOrder: byId[seed.alreadyAttachedForeignChangeOrder.id],
    validJobPayment: byId[seed.validJobPayment.id],
    foreignJobPayment: byId[seed.foreignJobPayment.id],
    validEstimatePayment: byId[seed.validEstimatePayment.id],
    foreignEstimatePayment: byId[seed.foreignEstimatePayment.id],
    alreadyAttachedForeignPayment: byId[seed.alreadyAttachedForeignPayment.id],
  };
}

async function restoreUnattached(seed) {
  await prisma.changeOrder.update({
    where: { id: seed.validChangeOrder.id },
    data: { invoiceId: null },
  });
  await prisma.changeOrder.update({
    where: { id: seed.foreignChangeOrder.id },
    data: { invoiceId: null },
  });
  await prisma.payment.update({
    where: { id: seed.validJobPayment.id },
    data: { invoiceId: null, jobId: seed.jobA.id },
  });
  await prisma.payment.update({
    where: { id: seed.foreignJobPayment.id },
    data: { invoiceId: null, jobId: seed.jobA.id },
  });
  await prisma.payment.update({
    where: { id: seed.validEstimatePayment.id },
    data: { invoiceId: null, jobId: null },
  });
  await prisma.payment.update({
    where: { id: seed.foreignEstimatePayment.id },
    data: { invoiceId: null, jobId: null },
  });
}

try {
  console.log("\nDYNAMIC — vulnerable joins cross-attach; corrective path does not");
  const seed = await seedLegacyRows();

  await prisma.$executeRawUnsafe(VULNERABLE_CHANGE_ORDER_SQL);
  await prisma.$executeRawUnsafe(VULNERABLE_PAYMENT_JOB_SQL);
  await prisma.$executeRawUnsafe(VULNERABLE_PAYMENT_ESTIMATE_SQL);
  const afterVulnerable = await reload(seed);
  check(
    "Vulnerable path backfills the valid same-business Change Order",
    afterVulnerable.validChangeOrder.invoiceId === seed.invoiceA.id,
  );
  check(
    "Vulnerable path cross-attaches the foreign Change Order (the defect)",
    afterVulnerable.foreignChangeOrder.invoiceId === seed.invoiceA.id,
  );
  check(
    "Vulnerable path cross-attaches the foreign job Payment (the defect)",
    afterVulnerable.foreignJobPayment.invoiceId === seed.invoiceA.id,
  );
  check(
    "Vulnerable path cross-attaches the foreign estimate Payment and inherits jobId",
    afterVulnerable.foreignEstimatePayment.invoiceId === seed.invoiceA.id &&
      afterVulnerable.foreignEstimatePayment.jobId === seed.jobA.id,
  );
  check(
    "Already-attached foreign rows stay attached during the vulnerable NULL-only UPDATEs",
    afterVulnerable.alreadyAttachedForeignChangeOrder.invoiceId === seed.invoiceA.id &&
      afterVulnerable.alreadyAttachedForeignPayment.invoiceId === seed.invoiceA.id &&
      afterVulnerable.alreadyAttachedForeignPayment.jobId === seed.jobA.id,
  );

  await restoreUnattached(seed);

  for (const statement of sqlStatements(correctiveMigration)) {
    await prisma.$executeRawUnsafe(statement);
  }

  const afterFix = await reload(seed);
  const findings = await prisma.$queryRaw`
    SELECT "category", "recordId"
    FROM "RevenueIntegrityBusinessIsolationFinding"
  `;
  const categories = new Set(findings.map((row) => row.category));
  const findingRecordIds = new Set(findings.map((row) => row.recordId));

  check(
    "Corrective path backfills the valid same-business Change Order",
    afterFix.validChangeOrder.invoiceId === seed.invoiceA.id,
  );
  check(
    "Corrective path backfills the valid same-business job Payment",
    afterFix.validJobPayment.invoiceId === seed.invoiceA.id &&
      afterFix.validJobPayment.jobId === seed.jobA.id,
  );
  check(
    "Corrective path backfills the valid same-business estimate Payment",
    afterFix.validEstimatePayment.invoiceId === seed.invoiceA.id &&
      afterFix.validEstimatePayment.jobId === seed.jobA.id,
  );
  check(
    "Foreign Change Order is never attached by the corrective path",
    afterFix.foreignChangeOrder.invoiceId == null,
  );
  check(
    "Foreign job Payment is never attached or reassigned by the corrective path",
    afterFix.foreignJobPayment.invoiceId == null &&
      afterFix.foreignJobPayment.jobId === seed.jobA.id,
  );
  check(
    "Foreign estimate Payment is never attached and does not inherit a foreign jobId",
    afterFix.foreignEstimatePayment.invoiceId == null &&
      afterFix.foreignEstimatePayment.jobId == null,
  );
  check(
    "Already-attached foreign financial rows are not reassigned",
    afterFix.alreadyAttachedForeignChangeOrder.invoiceId === seed.invoiceA.id &&
      afterFix.alreadyAttachedForeignPayment.invoiceId === seed.invoiceA.id &&
      afterFix.alreadyAttachedForeignPayment.jobId === seed.jobA.id &&
      afterFix.alreadyAttachedForeignChangeOrder.businessId === seed.businessB.id &&
      afterFix.alreadyAttachedForeignPayment.businessId === seed.businessB.id,
  );
  check(
    "Detection ledger records already-attached cross-business financial links",
    categories.has("change_order_attached_foreign_invoice") &&
      categories.has("payment_attached_foreign_invoice") &&
      categories.has("change_order_job_business_mismatch") &&
      categories.has("payment_job_business_mismatch") &&
      findingRecordIds.has(seed.alreadyAttachedForeignChangeOrder.id) &&
      findingRecordIds.has(seed.alreadyAttachedForeignPayment.id),
  );
  check(
    "Detection ledger does not invent an ownership repair for foreign unattached rows",
    findingRecordIds.has(seed.foreignChangeOrder.id) &&
      findingRecordIds.has(seed.foreignJobPayment.id) &&
      afterFix.foreignChangeOrder.invoiceId == null &&
      afterFix.foreignJobPayment.invoiceId == null,
  );
  check(
    "Business B invoice is never used as an attach target for Business A rows",
    afterFix.validChangeOrder.invoiceId !== seed.invoiceB.id &&
      afterFix.validJobPayment.invoiceId !== seed.invoiceB.id,
  );

  if (
    afterFix.alreadyAttachedForeignChangeOrder.invoiceId === seed.invoiceA.id ||
    afterFix.alreadyAttachedForeignPayment.invoiceId === seed.invoiceA.id
  ) {
    console.log(
      "NOTE — synthetic already-attached cross-business fixtures were detected and left unchanged. No production reassignment policy was applied.",
    );
  }
} finally {
  await session.cleanup();
}

console.log(
  failed === 0
    ? `\nAll P1-03 revenue-integrity isolation checks passed (${passed}).`
    : `\n${failed} P1-03 revenue-integrity isolation check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);

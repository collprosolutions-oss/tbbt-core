/**
 * Job Profitability / Actual-vs-Estimate closeout proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-job-profitability-closeout.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  roleHasCapability,
  canAccessManagementConsole,
} = await import("@/lib/authorization");
const { visibleAppNav } = await import("@/lib/nav");
const {
  CLOSEOUT_IN_PROGRESS_MESSAGE,
  CLOSEOUT_READ_BOUND,
  LABOR_COST_NOT_RECORDED_MESSAGE,
  MATERIAL_COST_COVERAGE_INCOMPLETE_MESSAGE,
  MATERIAL_COST_NOT_RECORDED_MESSAGE,
  PROFITABILITY_CANNOT_BE_CALCULATED_MESSAGE,
  RECORDED_COST_DEFINITION,
  RECORDED_REVENUE_DEFINITION,
  assertCanReadJobProfitabilityCloseout,
  buildJobProfitabilityCloseout,
  formatCloseoutInstant,
  isolateApprovedEstimate,
  isolateApprovedEstimateLines,
  isolateSameBusinessJobExpenses,
  isolateSameBusinessJobInvoices,
  isolateSameBusinessJobMaterialItems,
  isolateSameBusinessJobPayments,
  isolateSameBusinessJobTimeEntries,
} = await import("@/lib/job-profitability-closeout");
const { loadJobProfitabilityCloseout } = await import("@/lib/job-profitability-closeout-data");
const { BUSINESS_TIMEZONE_CHANGE_MESSAGE } = await import("@/lib/business-timezone");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_job_profitability_closeout_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function makeAccess(businessId, role, membershipId, timezone = "America/New_York") {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { timezone },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

const now = new Date("2026-08-20T15:00:00.000Z");

function closeoutInput(overrides = {}) {
  const jobId = overrides.jobId ?? "job-1";
  const businessId = overrides.businessId ?? "biz-a";
  return {
    businessId,
    jobId,
    timeZone: "America/New_York",
    job: {
      id: jobId,
      businessId,
      status: "COMPLETED",
      customerId: "c1",
      customerName: "Ada",
      estimateId: "est-1",
      createdAt: now,
      scheduledDurationMinutes: 120,
      approvedEstimateVersionTotal: 1000,
      approvedEstimateVersionNumber: 1,
    },
    estimates: [
      {
        id: "est-1",
        businessId,
        status: "APPROVED",
        total: 1000,
        createdAt: now,
        customerId: "c1",
        serviceRequestId: null,
      },
    ],
    estimateLines: [
      { estimateId: "est-1", type: "LABOR", quantity: 1, total: 600, fromApprovedVersion: true },
      { estimateId: "est-1", type: "MATERIAL", quantity: 1, total: 300, fromApprovedVersion: true },
      { estimateId: "est-1", type: "OTHER", quantity: 1, total: 100, fromApprovedVersion: true },
    ],
    invoices: [
      {
        id: "inv-1",
        businessId,
        status: "PAID",
        total: 1000,
        paidAt: now,
        createdAt: now,
        customerId: "c1",
        jobId,
        paymentMethod: "CASH",
        paymentReference: null,
      },
    ],
    payments: [
      {
        id: "pay-1",
        businessId,
        customerId: "c1",
        jobId,
        invoiceId: "inv-1",
        purpose: "INVOICE_BALANCE",
        amount: 1000,
        method: "CASH",
        receivedAt: now,
      },
    ],
    timeEntries: [
      {
        id: "t-job",
        businessId,
        jobId,
        activityType: "JOB",
        status: "APPROVED",
        startedAt: now,
        approvedHours: 8,
        approvedLaborCost: 200,
      },
    ],
    expenses: [
      {
        id: "e-mat",
        businessId,
        occurredOn: now,
        description: "Lumber",
        amount: 250,
        category: "MATERIALS",
        vendor: "Depot",
        jobId,
        recurring: false,
      },
      {
        id: "e-other",
        businessId,
        occurredOn: now,
        description: "Fuel",
        amount: 50,
        category: "GAS_FUEL",
        vendor: "Shell",
        jobId,
        recurring: false,
      },
    ],
    materialItems: [
      {
        id: "m-1",
        businessId,
        jobId,
        status: "PURCHASED",
        actualCost: 250,
        expenseId: "e-mat",
        expense: {
          id: "e-mat",
          businessId,
          jobId,
          amount: 250,
          voidedAt: null,
          category: "MATERIALS",
        },
      },
    ],
    changeOrders: [],
    readsTruncated: false,
    ...overrides,
  };
}

try {
  const libSrc = readFileSync(new URL("../src/lib/job-profitability-closeout.ts", import.meta.url), "utf8");
  const dataSrc = readFileSync(new URL("../src/lib/job-profitability-closeout-data.ts", import.meta.url), "utf8");
  const pageSrc = readFileSync(
    new URL("../src/app/(app)/jobs/[jobId]/profitability/page.tsx", import.meta.url),
    "utf8",
  );
  const uiSrc = readFileSync(
    new URL("../src/components/jobs/job-profitability-closeout.tsx", import.meta.url),
    "utf8",
  );
  const navSrc = readFileSync(new URL("../src/lib/nav.ts", import.meta.url), "utf8");
  const jobPageSrc = readFileSync(new URL("../src/app/(app)/jobs/[jobId]/page.tsx", import.meta.url), "utf8");
  const packageSrc = readFileSync(new URL("../package.json", import.meta.url), "utf8");

  console.log("\nSTATIC — Read-only surface and authorization");
  const mutationPattern =
    /prisma\.(create|update|delete|upsert|updateMany|deleteMany|createMany)|\$executeRaw|\$transaction/;
  check("18. Closeout library has no Prisma mutations", !/prisma\./.test(libSrc) && !/\$executeRaw/.test(libSrc));
  check("18. Closeout data loader has no writes", !mutationPattern.test(dataSrc) && dataSrc.includes("Read-only"));
  check("18. Profitability page has no writes", !mutationPattern.test(pageSrc) && pageSrc.includes("loadJobProfitabilityCloseout"));
  check("Page load uses requireManagementPageAccess", pageSrc.includes("requireManagementPageAccess"));
  check("Loader asserts VIEW_REPORTS / management financial access", dataSrc.includes("assertCanReadJobProfitabilityCloseout"));
  check("No global nav destination was added", !navSrc.includes("/profitability"));
  check("Main job page was not rewritten for this feature", !jobPageSrc.includes("/profitability"));
  check("package.json was not given a new npm script", !packageSrc.includes("job-profitability-closeout"));
  check("UI names data coverage, not AI confidence", uiSrc.includes("not AI confidence") && uiSrc.includes("Data coverage"));
  check("MEMBER has no VIEW_REPORTS", !roleHasCapability("MEMBER", CAPABILITIES.VIEW_REPORTS));
  check("MEMBER cannot access the management console", !canAccessManagementConsole("MEMBER"));
  check("OWNER/ADMIN retain VIEW_REPORTS", roleHasCapability("OWNER", CAPABILITIES.VIEW_REPORTS) && roleHasCapability("ADMIN", CAPABILITIES.VIEW_REPORTS));
  check("Profitability is not in MEMBER nav", !visibleAppNav("MEMBER").some((item) => item.href.includes("profitability")));

  let memberBlocked = false;
  try {
    assertCanReadJobProfitabilityCloseout(makeAccess("biz-a", "MEMBER", "mem-m"));
  } catch (error) {
    memberBlocked = error instanceof ForbiddenError;
  }
  check("16. MEMBER cannot read financial closeout", memberBlocked);

  let memberReportsBlocked = false;
  try {
    requireBusinessCapability(makeAccess("biz-a", "MEMBER", "mem-m"), CAPABILITIES.VIEW_REPORTS);
  } catch (error) {
    memberReportsBlocked = error instanceof ForbiddenError;
  }
  check("16. MEMBER VIEW_REPORTS fails closed", memberReportsBlocked);

  console.log("\nSTATIC — Timezone display does not rewrite stored timestamps");
  const stored = new Date("2026-08-15T07:00:00.000Z");
  const la = formatCloseoutInstant(stored, "America/Los_Angeles");
  const ny = formatCloseoutInstant(stored, "America/New_York");
  check("17. Same stored instant formats differently by Business.timezone", la !== ny);
  check("17. Stored ISO timestamp is unchanged", stored.toISOString() === "2026-08-15T07:00:00.000Z");
  check("17. Loader uses resolveBusinessTimeZone", dataSrc.includes("resolveBusinessTimeZone"));
  check("17. Timezone change does not rewrite stored timestamps", /does NOT rewrite the UTC timestamps/.test(BUSINESS_TIMEZONE_CHANGE_MESSAGE));
  check("17. UI says stored UTC timestamps are not rewritten", uiSrc.includes("Stored UTC timestamps are not rewritten"));

  console.log("\nSTATIC — Approved estimate truth");
  const dirtyDraftLines = [
    { estimateId: "est-1", type: "LABOR", quantity: 1, total: 9999, fromApprovedVersion: false },
    { estimateId: "est-1", type: "MATERIAL", quantity: 1, total: 8888, fromApprovedVersion: false },
    { estimateId: "est-1", type: "OTHER", quantity: 1, total: 7777, fromApprovedVersion: false },
  ];
  const approved = buildJobProfitabilityCloseout(
    closeoutInput({
      estimates: [
        { id: "est-1", businessId: "biz-a", status: "APPROVED", total: 1000, createdAt: now, customerId: "c1", serviceRequestId: null },
        { id: "est-draft", businessId: "biz-a", status: "DRAFT", total: 5000, createdAt: now, customerId: "c1", serviceRequestId: null },
        { id: "est-sent", businessId: "biz-a", status: "SENT", total: 4000, createdAt: now, customerId: "c1", serviceRequestId: null },
      ],
      estimateLines: [
        { estimateId: "est-1", type: "LABOR", quantity: 1, total: 600, fromApprovedVersion: true },
        { estimateId: "est-1", type: "MATERIAL", quantity: 1, total: 300, fromApprovedVersion: true },
        { estimateId: "est-1", type: "OTHER", quantity: 1, total: 100, fromApprovedVersion: true },
        ...dirtyDraftLines,
        { estimateId: "est-sent", type: "LABOR", quantity: 1, total: 4000, fromApprovedVersion: false },
      ],
    }),
  );
  check("1. Approved estimate total is used", approved?.sold.approvedEstimateTotal === 1000);
  check("1. Approved labor/material/other line totals are used", approved?.sold.estimatedLaborLineTotal === 600 && approved?.sold.estimatedMaterialLineTotal === 300 && approved?.sold.estimatedOtherLineTotal === 100);
  check("2. DRAFT/SENT lines are not substituted for approved truth", approved?.sold.usedDraftOrSentAsApproved === false && approved?.sold.approvedEstimateTotal !== 5000 && approved?.sold.estimatedLaborLineTotal !== 9999);
  const approvedRow = isolateApprovedEstimate(
    [
      { id: "est-1", businessId: "biz-a", status: "SENT", total: 4000, createdAt: now, customerId: "c1", serviceRequestId: null },
      { id: "est-1", businessId: "biz-a", status: "APPROVED", total: 1000, createdAt: now, customerId: "c1", serviceRequestId: null },
    ],
    "biz-a",
    "est-1",
  );
  check("2. isolateApprovedEstimate keeps APPROVED only", approvedRow?.status === "APPROVED" && approvedRow?.total === 1000);
  const isolatedLines = isolateApprovedEstimateLines(
    [
      { estimateId: "est-1", type: "LABOR", quantity: 1, total: 600, fromApprovedVersion: true },
      { estimateId: "est-1", type: "LABOR", quantity: 1, total: 9999, fromApprovedVersion: false },
    ],
    approvedRow,
  );
  check("2. Approved version lines win over live DRAFT-shaped lines", isolatedLines.length === 1 && isolatedLines[0].total === 600);

  const draftOnly = buildJobProfitabilityCloseout(
    closeoutInput({
      job: {
        id: "job-1",
        businessId: "biz-a",
        status: "COMPLETED",
        customerId: "c1",
        customerName: "Ada",
        estimateId: "est-draft",
        createdAt: now,
        scheduledDurationMinutes: null,
        approvedEstimateVersionTotal: null,
        approvedEstimateVersionNumber: null,
      },
      estimates: [
        { id: "est-draft", businessId: "biz-a", status: "DRAFT", total: 5000, createdAt: now, customerId: "c1", serviceRequestId: null },
      ],
      estimateLines: [{ estimateId: "est-draft", type: "LABOR", quantity: 1, total: 5000, fromApprovedVersion: false }],
    }),
  );
  check("2. DRAFT estimate is not approved truth", draftOnly?.sold.approvedEstimateTotal === null && draftOnly?.coverage.estimate === "Partial");

  console.log("\nSTATIC — Same-job billing and foreign isolation");
  const billed = buildJobProfitabilityCloseout(
    closeoutInput({
      invoices: [
        { id: "inv-1", businessId: "biz-a", status: "PAID", total: 1000, paidAt: now, createdAt: now, customerId: "c1", jobId: "job-1", paymentMethod: "CASH", paymentReference: null },
        { id: "inv-sent", businessId: "biz-a", status: "SENT", total: 200, paidAt: null, createdAt: now, customerId: "c1", jobId: "job-1", paymentMethod: null, paymentReference: null },
        { id: "inv-foreign-job", businessId: "biz-a", status: "PAID", total: 9999, paidAt: now, createdAt: now, customerId: "c1", jobId: "job-other", paymentMethod: "CASH", paymentReference: null },
        { id: "inv-foreign-biz", businessId: "biz-b", status: "PAID", total: 8888, paidAt: now, createdAt: now, customerId: "c1", jobId: "job-1", paymentMethod: "CASH", paymentReference: null },
        { id: "inv-draft", businessId: "biz-a", status: "DRAFT", total: 50, paidAt: null, createdAt: now, customerId: "c1", jobId: "job-1", paymentMethod: null, paymentReference: null },
      ],
      payments: [
        { id: "pay-1", businessId: "biz-a", customerId: "c1", jobId: "job-1", invoiceId: "inv-1", purpose: "INVOICE_BALANCE", amount: 1000, method: "CASH", receivedAt: now },
        { id: "pay-sent", businessId: "biz-a", customerId: "c1", jobId: "job-1", invoiceId: "inv-sent", purpose: "INVOICE_BALANCE", amount: 40, method: "CASH", receivedAt: now },
        { id: "pay-foreign-job", businessId: "biz-a", customerId: "c1", jobId: "job-other", invoiceId: "inv-foreign-job", purpose: "INVOICE_BALANCE", amount: 9999, method: "CASH", receivedAt: now },
        { id: "pay-foreign-biz", businessId: "biz-b", customerId: "c1", jobId: "job-1", invoiceId: "inv-1", purpose: "INVOICE_BALANCE", amount: 8888, method: "CASH", receivedAt: now },
      ],
    }),
  );
  check("3. Same-job billed invoice total is SENT+PAID only (1200)", billed?.billing.invoiceTotal === 1200);
  check("4. Same-job recorded payments are 1040", billed?.billing.recordedPayments === 1040);
  check("5. Foreign-business and other-job payments cannot enter", billed?.billing.recordedPayments !== 1040 + 9999 && billed?.billing.recordedPayments !== 1040 + 8888);
  check("6. Foreign invoice cannot enter billed total", billed?.billing.invoiceTotal !== 1200 + 9999 && billed?.billing.invoiceTotal !== 1200 + 8888);
  check("3. DRAFT invoice is not billed revenue", billed?.billing.invoiceTotal !== 1250);
  check("4. Outstanding is remaining SENT balance (160)", billed?.billing.outstandingBalance === 160);

  const isolatedInvoices = isolateSameBusinessJobInvoices(
    [
      { id: "a", businessId: "biz-a", status: "PAID", total: 1, paidAt: now, createdAt: now, customerId: "c1", jobId: "job-1", paymentMethod: null, paymentReference: null },
      { id: "b", businessId: "biz-b", status: "PAID", total: 9, paidAt: now, createdAt: now, customerId: "c1", jobId: "job-1", paymentMethod: null, paymentReference: null },
      { id: "c", businessId: "biz-a", status: "PAID", total: 8, paidAt: now, createdAt: now, customerId: "c1", jobId: "job-x", paymentMethod: null, paymentReference: null },
    ],
    "biz-a",
    "job-1",
  );
  check("6. Invoice isolate drops foreign business and other jobs", isolatedInvoices.length === 1 && isolatedInvoices[0].id === "a");

  const isolatedPayments = isolateSameBusinessJobPayments(
    [
      { id: "p1", businessId: "biz-a", customerId: "c1", jobId: "job-1", invoiceId: "a", purpose: "INVOICE_BALANCE", amount: 1, method: "CASH", receivedAt: now },
      { id: "p2", businessId: "biz-b", customerId: "c1", jobId: "job-1", invoiceId: "a", purpose: "INVOICE_BALANCE", amount: 9, method: "CASH", receivedAt: now },
      { id: "p3", businessId: "biz-a", customerId: "c1", jobId: "job-x", invoiceId: "c", purpose: "INVOICE_BALANCE", amount: 8, method: "CASH", receivedAt: now },
    ],
    isolatedInvoices,
    "biz-a",
    "job-1",
  );
  check("5. Payment isolate drops foreign business and other jobs", isolatedPayments.length === 1 && isolatedPayments[0].id === "p1");

  console.log("\nSTATIC — Materials, time, and missing cost honesty");
  const dirtyMaterials = buildJobProfitabilityCloseout(
    closeoutInput({
      expenses: [
        { id: "e-mat", businessId: "biz-a", occurredOn: now, description: "Lumber", amount: 250, category: "MATERIALS", vendor: "Depot", jobId: "job-1", recurring: false },
        { id: "e-foreign-job", businessId: "biz-a", occurredOn: now, description: "Other job lumber", amount: 700, category: "MATERIALS", vendor: "Depot", jobId: "job-other", recurring: false },
        { id: "e-foreign-biz", businessId: "biz-b", occurredOn: now, description: "Tenant B lumber", amount: 800, category: "MATERIALS", vendor: "Depot", jobId: "job-1", recurring: false },
      ],
      materialItems: [
        { id: "m-1", businessId: "biz-a", jobId: "job-1", status: "PURCHASED", actualCost: 250, expenseId: "e-mat", expense: { id: "e-mat", businessId: "biz-a", jobId: "job-1", amount: 250, voidedAt: null, category: "MATERIALS" } },
        { id: "m-foreign", businessId: "biz-b", jobId: "job-1", status: "PURCHASED", actualCost: 800, expenseId: "e-foreign-biz", expense: { id: "e-foreign-biz", businessId: "biz-b", jobId: "job-1", amount: 800, voidedAt: null, category: "MATERIALS" } },
        { id: "m-other-job", businessId: "biz-a", jobId: "job-other", status: "PURCHASED", actualCost: 700, expenseId: "e-foreign-job", expense: { id: "e-foreign-job", businessId: "biz-a", jobId: "job-other", amount: 700, voidedAt: null, category: "MATERIALS" } },
      ],
    }),
  );
  check("7. Recorded material cost is only same-job canonical expense (250)", dirtyMaterials?.actualWork.materialCost.amount === 250);
  check("8. Foreign material rows cannot enter", dirtyMaterials?.actualWork.materialCost.amount !== 1050 && dirtyMaterials?.actualWork.materialCost.amount !== 950);
  check(
    "7. Material isolate keeps one same-business/job row",
    isolateSameBusinessJobMaterialItems(
      dirtyMaterials
        ? [
            { id: "m-1", businessId: "biz-a", jobId: "job-1", status: "PURCHASED", actualCost: 250, expenseId: "e-mat", expense: null },
            { id: "m-b", businessId: "biz-b", jobId: "job-1", status: "PURCHASED", actualCost: 800, expenseId: null, expense: null },
          ]
        : [],
      "biz-a",
      "job-1",
    ).length === 1,
  );
  check(
    "7. Expense isolate drops foreign rows",
    isolateSameBusinessJobExpenses(
      [
        { id: "e-mat", businessId: "biz-a", occurredOn: now, description: "Lumber", amount: 250, category: "MATERIALS", vendor: "Depot", jobId: "job-1", recurring: false },
        { id: "e-b", businessId: "biz-b", occurredOn: now, description: "X", amount: 800, category: "MATERIALS", vendor: "Depot", jobId: "job-1", recurring: false },
      ],
      "biz-a",
      "job-1",
    ).length === 1,
  );

  const hours = buildJobProfitabilityCloseout(
    closeoutInput({
      timeEntries: [
        { id: "t-job", businessId: "biz-a", jobId: "job-1", activityType: "JOB", status: "APPROVED", startedAt: now, approvedHours: 8, approvedLaborCost: 200 },
        { id: "t-travel", businessId: "biz-a", jobId: "job-1", activityType: "TRAVEL", status: "APPROVED", startedAt: now, approvedHours: 1, approvedLaborCost: 25 },
        { id: "t-pickup", businessId: "biz-a", jobId: "job-1", activityType: "MATERIAL_PICKUP", status: "APPROVED", startedAt: now, approvedHours: 0.5, approvedLaborCost: 12.5 },
        { id: "t-other-job", businessId: "biz-a", jobId: "job-other", activityType: "JOB", status: "APPROVED", startedAt: now, approvedHours: 40, approvedLaborCost: 1000 },
        { id: "t-foreign", businessId: "biz-b", jobId: "job-1", activityType: "JOB", status: "APPROVED", startedAt: now, approvedHours: 30, approvedLaborCost: 900 },
        { id: "t-unapproved", businessId: "biz-a", jobId: "job-1", activityType: "JOB", status: "READY", startedAt: now, approvedHours: null, approvedLaborCost: null },
      ],
    }),
  );
  check("9. Same-job approved JOB hours are 8", hours?.actualWork.jobHours.hours === 8);
  check("9. Travel and pickup stay separate", hours?.actualWork.travelHours.hours === 1 && hours?.actualWork.materialPickupHours.hours === 0.5);
  check("10. Unrelated job and foreign-business time cannot enter", hours?.actualWork.jobHours.hours !== 48 && hours?.actualWork.jobHours.hours !== 38);
  check(
    "10. Time isolate drops other jobs",
    isolateSameBusinessJobTimeEntries(
      [
        { id: "t-job", businessId: "biz-a", jobId: "job-1", activityType: "JOB", status: "APPROVED", startedAt: now, approvedHours: 8, approvedLaborCost: 200 },
        { id: "t-x", businessId: "biz-a", jobId: "job-other", activityType: "JOB", status: "APPROVED", startedAt: now, approvedHours: 40, approvedLaborCost: 1000 },
      ],
      "biz-a",
      "job-1",
    ).length === 1,
  );

  const missingLabor = buildJobProfitabilityCloseout(
    closeoutInput({
      timeEntries: [
        { id: "t-job", businessId: "biz-a", jobId: "job-1", activityType: "JOB", status: "APPROVED", startedAt: now, approvedHours: 8, approvedLaborCost: null },
      ],
    }),
  );
  check("11. Missing labor cost is not recorded, not $0", missingLabor?.actualWork.laborCost.amount === null && missingLabor?.actualWork.laborCost.message === LABOR_COST_NOT_RECORDED_MESSAGE);
  check("11. Missing labor cost does not become a $0 profit input", missingLabor?.profitability.recordedAttributableCost !== 300 && missingLabor?.profitability.available === false);

  const noLabor = buildJobProfitabilityCloseout(closeoutInput({ timeEntries: [] }));
  check("11. No time entries leave labor cost not recorded", noLabor?.actualWork.laborCost.amount === null && noLabor?.coverage.laborCost === "Not recorded");

  const unlinkedMaterials = buildJobProfitabilityCloseout(
    closeoutInput({
      expenses: [
        { id: "e-other", businessId: "biz-a", occurredOn: now, description: "Fuel", amount: 50, category: "GAS_FUEL", vendor: "Shell", jobId: "job-1", recurring: false },
      ],
      materialItems: [
        { id: "m-1", businessId: "biz-a", jobId: "job-1", status: "PURCHASED", actualCost: 250, expenseId: null, expense: null },
      ],
    }),
  );
  check("12. Unlinked purchase actualCost is not silently $0 material cost", unlinkedMaterials?.actualWork.materialCost.amount === null);
  check("12. Material coverage is incomplete when allocation is unlinked", unlinkedMaterials?.coverage.materials === "Partial" && unlinkedMaterials?.actualWork.materialCost.message === MATERIAL_COST_COVERAGE_INCOMPLETE_MESSAGE);

  const noMaterials = buildJobProfitabilityCloseout(
    closeoutInput({
      estimateLines: [{ estimateId: "est-1", type: "LABOR", quantity: 1, total: 1000, fromApprovedVersion: true }],
      expenses: [],
      materialItems: [],
    }),
  );
  check("12. Missing material cost is not $0", noMaterials?.actualWork.materialCost.amount === null && noMaterials?.actualWork.materialCost.message === MATERIAL_COST_NOT_RECORDED_MESSAGE);

  const partialProfit = buildJobProfitabilityCloseout(
    closeoutInput({
      timeEntries: [
        { id: "t-job", businessId: "biz-a", jobId: "job-1", activityType: "JOB", status: "APPROVED", startedAt: now, approvedHours: 8, approvedLaborCost: null },
      ],
      expenses: [],
      materialItems: [
        { id: "m-1", businessId: "biz-a", jobId: "job-1", status: "PURCHASED", actualCost: 250, expenseId: null, expense: null },
      ],
    }),
  );
  check("13. Partial coverage does not produce a full-profit number", partialProfit?.profitability.available === false && partialProfit?.profitability.grossProfit === null);
  check("13. Partial closeout names the gap instead of inflating profit", partialProfit?.profitability.message === LABOR_COST_NOT_RECORDED_MESSAGE || partialProfit?.profitability.message === MATERIAL_COST_COVERAGE_INCOMPLETE_MESSAGE || partialProfit?.profitability.message === PROFITABILITY_CANNOT_BE_CALCULATED_MESSAGE);

  console.log("\nSTATIC — Completed vs in-progress and example fixture");
  const complete = buildJobProfitabilityCloseout(closeoutInput());
  check("14. Completed job can show closeout", complete?.closeoutInProgress === false && complete?.profitability.available === true);
  check("Example recorded revenue is $1,000 billed", complete?.profitability.recordedRevenue === 1000);
  check("Example recorded cost is $200 labor + $250 materials + $50 other = $500", complete?.profitability.recordedAttributableCost === 500);
  check("Example gross profit is $500", complete?.profitability.grossProfit === 500);
  check("Example coverage is complete on recorded categories", complete?.coverage.estimate === "Complete" && complete?.coverage.laborCost === "Complete" && complete?.coverage.materials === "Complete" && complete?.coverage.invoice === "Complete");
  check("Revenue and cost definitions are explicit", complete?.profitability.revenueDefinition === RECORDED_REVENUE_DEFINITION && complete?.profitability.costDefinition === RECORDED_COST_DEFINITION);
  check("Estimate vs invoice variance is $0 on the fixture", complete?.variance.estimateVsInvoice?.variance === 0);
  check("Invoice vs payments variance is $0 on the fixture", complete?.variance.invoiceVsPayments?.variance === 0);
  check("Labor dollars are not compared to hours as a dollar variance", complete?.variance.laborCost === null);

  const active = buildJobProfitabilityCloseout(
    closeoutInput({
      job: {
        id: "job-1",
        businessId: "biz-a",
        status: "IN_PROGRESS",
        customerId: "c1",
        customerName: "Ada",
        estimateId: "est-1",
        createdAt: now,
        scheduledDurationMinutes: 120,
        approvedEstimateVersionTotal: 1000,
        approvedEstimateVersionNumber: 1,
      },
    }),
  );
  check("15. Active job is clearly still in progress", active?.closeoutInProgress === true && active?.closeoutStatusMessage === CLOSEOUT_IN_PROGRESS_MESSAGE);
  check("15. Active job does not fabricate final profitability", active?.profitability.available === false && active?.profitability.grossProfit === null);
  check("15. Active job still shows recorded billing", active?.billing.invoiceTotal === 1000 && active?.billing.recordedPayments === 1000);

  const foreignJob = buildJobProfitabilityCloseout(closeoutInput({ job: { ...closeoutInput().job, businessId: "biz-b" } }));
  check("Foreign job id / tenant mismatch fails closed", foreignJob === null);
  check("Missing job fails closed", buildJobProfitabilityCloseout(closeoutInput({ job: null })) === null);
  check("Closeout read bound is deterministic", CLOSEOUT_READ_BOUND === 200 && dataSrc.includes("CLOSEOUT_READ_BOUND"));

  console.log("\nDB — Tenant-scoped loader");
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-closeout-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-closeout-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Beta Owner", email: `beta-closeout-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Closeout",
      slug: `alpha-closeout-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Closeout",
      slug: `beta-closeout-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Closeout" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Customer" },
  });

  const estimateA = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "APPROVED",
      total: new Prisma.Decimal(1000),
      publicToken: randomUUID(),
      lineItems: {
        create: [
          { businessId: businessA.id, description: "Live draft-shaped labor", quantity: 1, unitPrice: 9999, total: 9999, type: "LABOR" },
          { businessId: businessA.id, description: "Live draft-shaped material", quantity: 1, unitPrice: 8888, total: 8888, type: "MATERIAL" },
        ],
      },
    },
  });
  const versionA = await prisma.estimateVersion.create({
    data: {
      businessId: businessA.id,
      estimateId: estimateA.id,
      versionNumber: 1,
      total: new Prisma.Decimal(1000),
      laborMinimumWaived: false,
      laborMinimumAdjustment: 0,
      approvedAt: now,
      lineItems: {
        create: [
          { businessId: businessA.id, description: "Approved labor", quantity: 1, unitPrice: 600, total: 600, type: "LABOR" },
          { businessId: businessA.id, description: "Approved material", quantity: 1, unitPrice: 300, total: 300, type: "MATERIAL" },
          { businessId: businessA.id, description: "Approved other", quantity: 1, unitPrice: 100, total: 100, type: "OTHER" },
        ],
      },
    },
  });
  await prisma.estimate.update({
    where: { id: estimateA.id },
    data: { approvedVersionId: versionA.id },
  });

  const jobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      estimateId: estimateA.id,
      approvedEstimateVersionId: versionA.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const jobOther = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
    },
  });
  const jobB = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });

  const invoiceA = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: jobA.id,
      status: "PAID",
      total: new Prisma.Decimal(1000),
      paidAt: now,
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: jobOther.id,
      status: "PAID",
      total: new Prisma.Decimal(9999),
      paidAt: now,
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      jobId: jobB.id,
      status: "PAID",
      total: new Prisma.Decimal(8888),
      paidAt: now,
    },
  });
  await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: jobA.id,
      invoiceId: invoiceA.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(1000),
      method: "CASH",
      receivedAt: now,
    },
  });
  await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: jobOther.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(9999),
      method: "CASH",
      receivedAt: now,
    },
  });
  await prisma.payment.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      jobId: jobB.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(8888),
      method: "CASH",
      receivedAt: now,
    },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id, "America/Los_Angeles");
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id, "America/Los_Angeles");

  const membershipForTime = ownerMem.id;
  await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: membershipForTime,
      jobId: jobA.id,
      activityType: "JOB",
      status: "APPROVED",
      startedAt: now,
      endedAt: new Date(now.getTime() + 8 * 60 * 60 * 1000),
      source: "MANUAL",
      approvedHours: new Prisma.Decimal(8),
      approvedLaborCost: new Prisma.Decimal(200),
    },
  });
  await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: membershipForTime,
      jobId: jobOther.id,
      activityType: "JOB",
      status: "APPROVED",
      startedAt: now,
      endedAt: new Date(now.getTime() + 40 * 60 * 60 * 1000),
      source: "MANUAL",
      approvedHours: new Prisma.Decimal(40),
      approvedLaborCost: new Prisma.Decimal(1000),
    },
  });

  const materialExpense = await prisma.expense.create({
    data: {
      businessId: businessA.id,
      occurredOn: now,
      description: "Lumber",
      amount: new Prisma.Decimal(250),
      category: "MATERIALS",
      vendor: "Depot",
      jobId: jobA.id,
    },
  });
  await prisma.expense.create({
    data: {
      businessId: businessA.id,
      occurredOn: now,
      description: "Fuel",
      amount: new Prisma.Decimal(50),
      category: "GAS_FUEL",
      vendor: "Shell",
      jobId: jobA.id,
    },
  });
  await prisma.expense.create({
    data: {
      businessId: businessB.id,
      occurredOn: now,
      description: "Beta lumber",
      amount: new Prisma.Decimal(800),
      category: "MATERIALS",
      vendor: "Depot",
      jobId: jobB.id,
    },
  });

  const listA = await prisma.materialPurchaseList.create({
    data: { businessId: businessA.id, jobId: jobA.id, estimateId: estimateA.id, estimateVersionId: versionA.id },
  });
  await prisma.materialPurchaseListItem.create({
    data: {
      businessId: businessA.id,
      purchaseListId: listA.id,
      name: "Lumber",
      quantityNeeded: new Prisma.Decimal(1),
      unit: "sheet",
      actualCost: new Prisma.Decimal(250),
      status: "PURCHASED",
      expenseId: materialExpense.id,
    },
  });

  const beforeCounts = {
    invoices: await prisma.invoice.count(),
    payments: await prisma.payment.count(),
    expenses: await prisma.expense.count(),
    timeEntries: await prisma.timeEntry.count(),
    jobs: await prisma.job.count(),
  };

  const loaded = await loadJobProfitabilityCloseout(prisma, ownerA, jobA.id);
  check("DB 1. Approved version total is used, not live 9999 lines", loaded?.sold.approvedEstimateTotal === 1000 && loaded?.sold.estimatedLaborLineTotal === 600);
  check("DB 2. Live DRAFT-shaped lines are not approved truth", loaded?.sold.estimatedMaterialLineTotal === 300 && loaded?.sold.estimatedOtherLineTotal === 100);
  check("DB 3. Same-job invoice total is 1000", loaded?.billing.invoiceTotal === 1000);
  check("DB 4. Same-job payments are 1000", loaded?.billing.recordedPayments === 1000);
  check("DB 5/6. Foreign invoice/payment totals did not enter", loaded?.billing.invoiceTotal !== 9999 + 1000 && loaded?.billing.recordedPayments !== 9999 + 1000);
  check("DB 7. Material cost is the linked same-job expense", loaded?.actualWork.materialCost.amount === 250);
  check("DB 9. Same-job hours are 8", loaded?.actualWork.jobHours.hours === 8);
  check("DB 10. Other-job 40 hours did not enter", loaded?.actualWork.jobHours.hours !== 48);
  check("DB 14. Completed job can show closeout", loaded?.closeoutInProgress === false && loaded?.profitability.available === true);
  check("DB example profit is 1000 - 500 = 500", loaded?.profitability.grossProfit === 500 && loaded?.profitability.recordedAttributableCost === 500);
  check("DB 17. Display timezone is Business.timezone", loaded?.timeZone === "America/Los_Angeles");

  const foreignLoad = await loadJobProfitabilityCloseout(prisma, ownerA, jobB.id);
  check("Foreign job id fails closed", foreignLoad === null);

  let memberLoadBlocked = false;
  try {
    await loadJobProfitabilityCloseout(prisma, memberA, jobA.id);
  } catch (error) {
    memberLoadBlocked = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  check("16. MEMBER loader cannot read financial closeout", memberLoadBlocked);

  const afterCounts = {
    invoices: await prisma.invoice.count(),
    payments: await prisma.payment.count(),
    expenses: await prisma.expense.count(),
    timeEntries: await prisma.timeEntry.count(),
    jobs: await prisma.job.count(),
  };
  check(
    "18. Loader page-equivalent read does not mutate invoices/payments/expenses/time/jobs",
    afterCounts.invoices === beforeCounts.invoices &&
      afterCounts.payments === beforeCounts.payments &&
      afterCounts.expenses === beforeCounts.expenses &&
      afterCounts.timeEntries === beforeCounts.timeEntries &&
      afterCounts.jobs === beforeCounts.jobs,
  );

  const activeJob = await loadJobProfitabilityCloseout(prisma, ownerA, jobOther.id);
  check("15. DB active job is still in progress", activeJob?.closeoutInProgress === true && activeJob?.closeoutStatusMessage === CLOSEOUT_IN_PROGRESS_MESSAGE);

  const missingJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const missingCost = await loadJobProfitabilityCloseout(prisma, ownerA, missingJob.id);
  check("11. DB missing labor cost is not recorded", missingCost?.actualWork.laborCost.amount === null && missingCost?.actualWork.laborCost.message === LABOR_COST_NOT_RECORDED_MESSAGE);
  check("12. DB missing material cost is not $0", missingCost?.actualWork.materialCost.amount === null);
  check("13. DB incomplete coverage has no full-profit number", missingCost?.profitability.available === false && missingCost?.profitability.grossProfit === null);
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect().catch(() => {});
}

console.log(failures === 0 ? "\nAll job-profitability-closeout checks passed." : `\n${failures} job-profitability-closeout check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

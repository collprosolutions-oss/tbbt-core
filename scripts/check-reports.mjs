/**
 * Reports domain + isolation verification.
 *
 * Imports the REAL production helpers from src/lib/reports.ts and
 * src/lib/reports-data.ts. Time Cards ops produce APPROVED snapshots so
 * labor reporting consumes the same records the rest of TBBT writes.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-reports.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

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
  approveTimesheetWeek,
  createManualTimeEntry,
  updateMembershipWage,
} = await import("@/lib/time-card-ops");
const { createExpense } = await import("@/lib/expense-ops");
const {
  JOB_MARGIN_LABEL,
  PROFIT_LOSS_MESSAGE,
  TBBT_RECORDED_PL_LABEL,
  TAX_DISCLAIMER,
  buildReport,
  catalogIdForJob,
  parseReportArea,
  parseReportDate,
  percentChange,
  recordedVendor,
  resolveReportRange,
} = await import("@/lib/reports");
const { loadReportSource } = await import("@/lib/reports-data");
const { FOUNDER_PAGE_KEYS, KPI_CARD_COUNTS } = await import("@/lib/founder-design");
const { FOUNDER_REGIONS } = await import("@/lib/founder-regions");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_reports_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for reports test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

try {
  console.log("\nSTATIC — Reports domain helpers");
  check("Invalid area falls back to overview", parseReportArea("marketing") === "overview");
  check("Feb 30 is rejected (not normalized)", parseReportDate("2026-02-30") === null);
  check("Valid date parses", parseReportDate("2026-03-15") instanceof Date);
  check("percentChange(100, 50) is +100", percentChange(100, 50) === 100);
  check("percentChange never invents +Infinity when prior is 0", percentChange(80, 0) === null);
  check("percentChange(0, 0) is unavailable", percentChange(0, 0) === null);
  check("Blank vendor is not invented", recordedVendor("") === null && recordedVendor("   ") === null);
  check("Recorded vendor is kept as trimmed text", recordedVendor("  Home Depot  ") === "Home Depot");

  const now = new Date(2026, 7, 31);
  const month = resolveReportRange("month", undefined, undefined, now);
  check("This month is comparable", month.comparable === true && month.prior != null);
  check("This month starts Aug 1 2026", month.start?.getFullYear() === 2026 && month.start?.getMonth() === 7 && month.start?.getDate() === 1);
  const allTime = resolveReportRange("all", undefined, undefined, now);
  check("All time is not comparable", allTime.comparable === false && allTime.prior === null);
  const badCustom = resolveReportRange("custom", "2026-08-20", "2026-08-10", now);
  check("Inverted custom range falls back to this month", badCustom.preset === "month");

  check("FOUNDER_PAGE_KEYS includes reports", FOUNDER_PAGE_KEYS.includes("reports"));
  check("Reports has 5 KPI cards", KPI_CARD_COUNTS.reports === 5);
  check(
    "Reports founder regions match the implemented boxes",
    FOUNDER_REGIONS.reports.map((region) => region.id).join(",") === "summary,nav,charts,table,attention,page",
  );
  check("OWNER/ADMIN can access the management console", canAccessManagementConsole("OWNER") && canAccessManagementConsole("ADMIN"));
  check("MEMBER cannot access the management console", canAccessManagementConsole("MEMBER") === false);
  check("Reports nav is visible to OWNER", visibleAppNav("OWNER").some((item) => item.href === "/reports"));
  check("Reports nav is visible to ADMIN", visibleAppNav("ADMIN").some((item) => item.href === "/reports"));
  check("Reports nav is hidden from MEMBER", !visibleAppNav("MEMBER").some((item) => item.href === "/reports"));
  check("MEMBER does not have VIEW_REPORTS", !roleHasCapability("MEMBER", CAPABILITIES.VIEW_REPORTS));

  const businessA = await prisma.business.create({
    data: { name: "Alpha Reports", slug: `alpha-reports-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Reports", slug: `beta-reports-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-reports-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-reports-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-reports-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-owner-reports-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER", hourlyWage: new Prisma.Decimal(25) },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(20) },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);

  try {
    requireBusinessCapability(memberA, CAPABILITIES.VIEW_REPORTS);
    check("MEMBER VIEW_REPORTS is forbidden", false);
  } catch (error) {
    check("MEMBER VIEW_REPORTS is forbidden", error instanceof ForbiddenError);
  }
  requireBusinessCapability(adminA, CAPABILITIES.VIEW_REPORTS);
  requireBusinessCapability(ownerA, CAPABILITIES.VIEW_REPORTS);
  check("OWNER and ADMIN pass VIEW_REPORTS", true);

  const catalog = await prisma.serviceCatalogItem.create({
    data: { businessId: businessA.id, name: "Faucet repair", pricingMode: "FIXED", price: new Prisma.Decimal(150) },
  });
  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner", createdAt: new Date(2026, 7, 10) },
  });
  const priorCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Prior Patron", createdAt: new Date(2026, 6, 10) },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret", createdAt: new Date(2026, 7, 10) },
  });
  const request = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      serviceCatalogItemId: catalog.id,
      createdAt: new Date(2026, 7, 11),
    },
  });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      serviceRequestId: request.id,
      status: "APPROVED",
      total: new Prisma.Decimal(400),
      publicToken: randomUUID(),
      createdAt: new Date(2026, 7, 12),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: estimate.id,
      serviceCatalogItemId: catalog.id,
      description: "Faucet repair",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(400),
      total: new Prisma.Decimal(400),
    },
  });
  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      estimateId: estimate.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: new Date(2026, 7, 15),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      jobId: job.id,
      status: "PAID",
      total: new Prisma.Decimal(400),
      paidAt: new Date(2026, 7, 20),
      paymentMethod: "CASH",
      createdAt: new Date(2026, 7, 18),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "SENT",
      total: new Prisma.Decimal(80),
      createdAt: new Date(2026, 7, 22),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: priorCustomer.id,
      status: "PAID",
      total: new Prisma.Decimal(50),
      paidAt: new Date(2026, 6, 15),
      createdAt: new Date(2026, 6, 14),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      status: "PAID",
      total: new Prisma.Decimal(9999),
      paidAt: new Date(2026, 7, 20),
      createdAt: new Date(2026, 7, 20),
    },
  });

  const weekStart = new Date(2026, 7, 16);
  await updateMembershipWage(prisma, ownerA, { membershipId: memberMem.id, hourlyWage: "20" });
  await createManualTimeEntry(prisma, ownerA, {
    membershipId: memberMem.id,
    activityType: "JOB",
    jobId: job.id,
    startedAt: new Date(2026, 7, 17, 9, 0, 0),
    endedAt: new Date(2026, 7, 17, 13, 0, 0),
    note: "Approved job hours",
  });
  await createManualTimeEntry(prisma, ownerA, {
    membershipId: memberMem.id,
    activityType: "BREAK",
    startedAt: new Date(2026, 7, 17, 13, 0, 0),
    endedAt: new Date(2026, 7, 17, 13, 30, 0),
    note: "Unpaid break",
  });
  await approveTimesheetWeek(prisma, ownerA, { membershipId: memberMem.id, weekStartedAt: weekStart });

  await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      activityType: "JOB",
      status: "READY",
      startedAt: new Date(2026, 7, 18, 9, 0, 0),
      endedAt: new Date(2026, 7, 18, 17, 0, 0),
      source: "MANUAL",
    },
  });

  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  await createExpense(prisma, ownerA, {
    occurredOn: "2026-08-20",
    description: "Job materials",
    amount: "60.00",
    category: "MATERIALS",
    vendor: "Home Depot",
    jobId: job.id,
  });
  await createExpense(prisma, ownerA, {
    occurredOn: "2026-08-21",
    description: "Fuel — no vendor recorded",
    amount: "40.00",
    category: "GAS_FUEL",
    vendor: "   ",
  });
  await createExpense(prisma, ownerA, {
    occurredOn: "2026-07-15",
    description: "July materials outside selected month",
    amount: "25.00",
    category: "MATERIALS",
    vendor: "Home Depot",
  });
  await createExpense(prisma, ownerB, {
    occurredOn: "2026-08-20",
    description: "Beta secret expense",
    amount: "500.00",
    category: "OTHER",
    vendor: "Beta Vendor",
  });

  console.log("\nTEST — Tenant isolation and real invoice/labor numbers");
  const sourceA = await loadReportSource(prisma, businessA.id);
  const sourceB = await loadReportSource(prisma, businessB.id);
  check(
    "Business A source never includes Business B invoices",
    sourceA.invoices.every((invoice) => invoice.businessId === businessA.id) &&
      !sourceA.invoices.some((invoice) => invoice.total === 9999),
  );
  check(
    "Business B source never includes Business A customers",
    sourceB.customers.every((row) => row.name !== "Ada Homeowner"),
  );
  check("A paid invoice of 400 is loaded for A", sourceA.invoices.some((invoice) => invoice.status === "PAID" && invoice.total === 400));
  check("READY time is not loaded as approved labor", sourceA.approvedTimeEntries.every((entry) => entry.approvedHours != null));

  const range = resolveReportRange("month", undefined, undefined, now);
  const report = buildReport(sourceA, range);

  check("Paid revenue is 400 from the August paid invoice", report.paidRevenue.current === 400);
  check("Prior paid revenue is 50 from July", report.paidRevenue.prior === 50);
  check("Paid revenue change is calculated from real priors", report.paidRevenue.changePercent === 700);
  check("Outstanding is the SENT invoice only (80)", report.outstanding.current === 80 && report.outstanding.count === 1);
  check("Draft-less issued count includes SENT+PAID created in August", report.issuedInvoiceCount.current === 2);
  check("Average issued invoice is (400+80)/2", report.averageIssuedInvoice === 240);
  check("Completed jobs opened in August is 1", report.completedJobsOpened.current === 1);
  check("Approved hours are 4 (break excluded from paid cost, hours snapshot includes 0-hour break)", report.labor.approvedHours === 4);
  check("Approved labor cost is 4 × 20 = 80", report.labor.laborCost === 80);
  check("New customers in August is 1 (Ada)", report.newCustomers.current === 1);
  check("Customer count is 2", report.customerCount === 2);

  console.log("\nTEST — Recorded expenses, vendor spending, TBBT-recorded P&L, job allocation");
  check("$100 of recorded expenses in August appears as $100", report.recordedExpenses.current === 100);
  check("Outside-period July $25 is excluded from this month", report.expenseRecords.every((row) => row.amount !== 25));
  const categorySum = report.expensesByCategory.reduce((sum, row) => sum + row.amount, 0);
  check("Category totals reconcile to $100", categorySum === 100);
  check(
    "Materials $60 + Gas/Fuel $40",
    report.expensesByCategory.some((row) => row.id === "MATERIALS" && row.amount === 60) &&
      report.expensesByCategory.some((row) => row.id === "GAS_FUEL" && row.amount === 40),
  );
  check("Vendor totals use only recorded vendor (Home Depot $60)", report.vendorSpending.length === 1 && report.vendorSpending[0].name === "Home Depot" && report.vendorSpending[0].amount === 60);
  check("Blank vendor is omitted — not invented", !report.vendorSpending.some((row) => !row.name || row.name.trim() === ""));
  check("P&L revenue is paid invoices only (400)", report.profitLoss.revenue === 400);
  check("P&L expenses is recorded $100", report.profitLoss.expenses === 100);
  check("P&L recorded net is 400 − 100 = 300", report.profitLoss.recordedNet === 300);
  check("P&L label is TBBT-recorded P&L", report.profitLoss.label === TBBT_RECORDED_PL_LABEL);
  check("P&L message states TBBT-recorded, not tax books", report.profitLoss.message === PROFIT_LOSS_MESSAGE);
  check("Approved labor is informational and not subtracted again into net", report.profitLoss.laborCost === 80 && report.profitLoss.recordedNet === 300);
  check("Tax disclaimer is present", report.taxDisclaimer === TAX_DISCLAIMER);

  const jobRow = report.jobProfitability.find((row) => row.jobId === job.id);
  check("Job paid revenue is 400", jobRow?.paidRevenue === 400);
  check("Job labor cost is 80", jobRow?.laborCost === 80);
  check("Job recorded expense is only the allocated $60", jobRow?.recordedJobExpense === 60);
  check("Unallocated $40 does not hit the job", jobRow?.recordedJobExpense !== 100);
  check("Recorded job margin is 400 − 80 − 60 = 260", jobRow?.recordedMargin === 260);
  check("Job margin is labeled Recorded job margin", report.jobMarginLabel === JOB_MARGIN_LABEL);

  const faucet = catalogIdForJob({ estimateId: estimate.id }, sourceA);
  check("Faucet job attributes to the request catalog item", faucet === catalog.id);
  check(
    "Service revenue is attributed only through that relationship",
    report.revenueByService.some((row) => row.id === catalog.id && row.amount === 400),
  );

  const allRange = resolveReportRange("all", undefined, undefined, now);
  const allReport = buildReport(sourceA, allRange);
  check("All-time paid revenue includes July + August", allReport.paidRevenue.current === 450);
  check("All-time recorded expenses include July $25 + August $100", allReport.recordedExpenses.current === 125);
  check("All-time TBBT-recorded net is 450 − 125 = 325", allReport.profitLoss.recordedNet === 325);
  check("All-time does not invent a prior-period percentage", allReport.paidRevenue.changePercent === null);

  const sourceBReport = buildReport(sourceB, range);
  check("Business B paid revenue is only its own 9999", sourceBReport.paidRevenue.current === 9999);
  check("Business B does not see Ada or the 400 invoice", sourceBReport.revenueByCustomer.every((row) => row.name !== "Ada Homeowner"));
  check("Business A does not load Business B expenses", sourceA.expenses.every((expense) => expense.businessId === businessA.id) && !sourceA.expenses.some((expense) => expense.amount === 500));
  check("Business B expenses are only its own $500", sourceB.expenses.length === 1 && sourceB.expenses[0].amount === 500);
  check("Business B recorded expenses do not include A's $100", sourceBReport.recordedExpenses.current === 500);

  check("Needs attention includes the outstanding SENT invoice", report.attention.some((item) => item.detail.includes("outstanding")));
  check("READY time is not in the labor rollup", !report.labor.laborCostIncomplete && report.labor.entryCount === 2);

  console.log(
    failures === 0
      ? "\nAll reports checks passed."
      : `\n${failures} reports check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    /* ignore */
  }
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);

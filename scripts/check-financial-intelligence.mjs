/**
 * Financial + profit intelligence.
 *
 * Proves deterministic job math, unpaid ≠ cash, labor burden rules,
 * aggregations, receivables aging, known cash flow, tenant isolation,
 * role restrictions, and evidence-backed pricing recommendations.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-financial-intelligence.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { CAPABILITIES, ForbiddenError, requireBusinessCapability, roleHasCapability } = await import("@/lib/authorization");
const { visibleAppNav } = await import("@/lib/nav");
const { buildReport, resolveReportRange } = await import("@/lib/reports");
const { loadFinancialSource } = await import("@/lib/financial-intelligence-data");
const {
  ACCOUNTING_NOT_CONNECTED_MESSAGE,
  BANKING_NOT_CONNECTED_MESSAGE,
  getFinanceConnectionProvider,
} = await import("@/lib/finance-connections");
const {
  BANK_NOT_CONNECTED_MESSAGE,
  BURDEN_ASSUMPTION_MESSAGE,
  CASH_FLOW_COVERAGE_MESSAGE,
  CASH_FLOW_RECORDED_ONLY_MESSAGE,
  CUSTOMER_LABOR_CHARGE_LABEL,
  NO_BURDEN_CONFIGURED_MESSAGE,
  PAYROLL_GROSS_NOT_CASH_MESSAGE,
  PRICING_MIN_SAMPLE,
  WHOLE_JOB_RANGE_LABEL,
  applyLaborBurden,
  agingBucketForDays,
  buildCustomerLifetime,
  buildCustomerProfitability,
  buildFinancialIntelligence,
  buildKnownCashFlow,
  buildPricingRecommendations,
  buildReceivables,
  buildServiceProfitability,
  calculateJobProfitability,
  collectedRevenueForCustomer,
  collectedRevenueForInvoices,
  collectedRevenueForJob,
  detectRecurringExpensePatterns,
  emptyLaborBurdenConfig,
  estimateConversionFromSource,
  financialSignalsForBsos,
  invoiceBalanceDue,
  jobProfitabilityCsvRows,
  parseOptionalRate,
  parsePercentInput,
  reconcileCollectedRevenue,
} = await import("@/lib/financial-intelligence");
const { FinancialIntelligenceError, reviewRecurringExpensePattern, saveLaborBurdenSetting } = await import("@/lib/financial-intelligence-ops");
const { buildBsosRecommendations } = await import("@/lib/bsos");
const { hasProductCapability, requireProductCapability } = await import("@/lib/product-entitlements");
const { PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog");
const { joinLineDescription } = await import("@/lib/estimate-line-scope");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_financial_intel_test";
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

function financeSource(overrides = {}) {
  return {
    businessId: "biz-a",
    invoices: [],
    customers: [],
    jobs: [],
    estimates: [],
    serviceRequests: [],
    catalogItems: [],
    estimateLineItems: [],
    approvedTimeEntries: [],
    payrollRuns: [],
    memberships: [],
    expenses: [],
    payments: [],
    changeOrders: [],
    estimateLines: [],
    laborBurden: emptyLaborBurdenConfig(),
    financeConnections: getFinanceConnectionProvider().status(),
    recurringPatterns: [],
    ...overrides,
  };
}

try {
  console.log("\nSTATIC — Honesty and labor burden");
  check("Banking is Not Connected", /Not Connected/.test(BANK_NOT_CONNECTED_MESSAGE) && /Not Connected/.test(BANKING_NOT_CONNECTED_MESSAGE));
  check("Accounting is Not Connected", /Not Connected/.test(ACCOUNTING_NOT_CONNECTED_MESSAGE));
  check("Cash-flow coverage names recorded TBBT transactions", CASH_FLOW_COVERAGE_MESSAGE === "Based on recorded TBBT transactions.");
  check("Cash-flow message refuses an assumed bank balance", /No bank balance/.test(CASH_FLOW_RECORDED_ONLY_MESSAGE));
  check("Disconnected finance adapter is not connected", getFinanceConnectionProvider().connected === false);
  const adapterBalance = await getFinanceConnectionProvider().fetchExternalBalance();
  check("Adapter does not invent an external balance", adapterBalance.balance === null && adapterBalance.ok === false);

  check("Blank burden parses as unconfigured", parsePercentInput("") === null && parsePercentInput("  ") === null && parseOptionalRate("") === null);
  check("Percent field 1 is 1% = 0.01", parsePercentInput("1") === 0.01);
  check("Percent field 0.5 is 0.5% = 0.005", parsePercentInput("0.5") === 0.005);
  check("Percent field 12.5 is 12.5% = 0.125", parsePercentInput("12.5") === 0.125);
  check("Percent field 40 is 40% = 0.40", parsePercentInput("40") === 0.4);
  check("Percent field does not treat 0.2 as 20%", parsePercentInput("0.2") === 0.002);
  check("Target margin over 100% is rejected", parsePercentInput("101", { maxPercent: 100 }) === null);
  check("Burden 200% is allowed as an intentional documented range", parsePercentInput("200", { maxPercent: 200 }) === 2);
  const wageOnly = applyLaborBurden(200, emptyLaborBurdenConfig());
  check("No invented burden when unconfigured", wageOnly.burdenRate === null && wageOnly.burdenAmount === null && wageOnly.laborCostWithBurden === 200);
  check("Wage-only explanation is explicit", /wage only/i.test(wageOnly.explanation) && /No employer labor burden/.test(NO_BURDEN_CONFIGURED_MESSAGE));
  const withBurden = applyLaborBurden(200, { burdenRate: 0.1, targetGrossMarginRate: null, notes: null });
  check("Configured 10% burden adds 20", withBurden.burdenAmount === 20 && withBurden.laborCostWithBurden === 220 && withBurden.burdenSource === "business-default");
  check("Burden is labeled an owner assumption, not recorded cash", withBurden.kind === "owner-assumption" && /owner-configured 10% labor burden assumption/i.test(withBurden.explanation) && /planning assumption/.test(BURDEN_ASSUMPTION_MESSAGE));
  check("Incomplete wage stays incomplete even with a burden rate", applyLaborBurden(null, { burdenRate: 0.2, targetGrossMarginRate: null, notes: null }).laborCostWithBurden === null);

  const conversion = estimateConversionFromSource(
    [
      { status: "DRAFT", createdAt: new Date("2026-08-01") },
      { status: "SENT", createdAt: new Date("2026-08-02") },
      { status: "APPROVED", createdAt: new Date("2026-08-03") },
      { status: "APPROVED", createdAt: new Date("2026-08-04") },
    ],
    { start: new Date("2026-08-01"), end: new Date("2026-08-31") },
  );
  check("Conversion uses SENT+APPROVED as the sent denominator", conversion.sent === 3 && conversion.approved === 2);
  check("Conversion rate is 67%", conversion.conversionRate === 67);

  console.log("\nSTATIC — Job profitability arithmetic");
  const jobId = "job-1";
  const jobSource = financeSource({
    customers: [{ id: "c1", name: "Ada", createdAt: new Date("2026-01-01") }],
    catalogItems: [{ id: "svc-1", name: "Fence repair" }],
    estimates: [{ id: "est-1", status: "APPROVED", total: 1000, createdAt: new Date("2026-08-01"), customerId: "c1", serviceRequestId: "req-1" }],
    serviceRequests: [{ id: "req-1", serviceCatalogItemId: "svc-1", createdAt: new Date("2026-08-01"), status: "CONVERTED" }],
    jobs: [{ id: jobId, status: "COMPLETED", createdAt: new Date("2026-08-10"), customerId: "c1", estimateId: "est-1" }],
    changeOrders: [{ id: "co-1", jobId, status: "APPROVED", total: 200, approvedAt: new Date("2026-08-12") }],
    invoices: [
      { id: "inv-sent", businessId: "biz-a", status: "SENT", total: 800, paidAt: null, createdAt: new Date("2026-08-15"), customerId: "c1", jobId, paymentMethod: null, paymentReference: null },
      { id: "inv-paid", businessId: "biz-a", status: "PAID", total: 400, paidAt: new Date("2026-08-16"), createdAt: new Date("2026-08-16"), customerId: "c1", jobId, paymentMethod: "CASH", paymentReference: null },
    ],
    payments: [
      { id: "pay-1", businessId: "biz-a", customerId: "c1", jobId, invoiceId: "inv-paid", purpose: "INVOICE_BALANCE", amount: 400, method: "CASH", receivedAt: new Date("2026-08-16") },
    ],
    approvedTimeEntries: [
      { id: "t1", membershipId: "m1", jobId, activityType: "JOB", startedAt: new Date("2026-08-11"), approvedHours: 10, approvedLaborCost: 200 },
    ],
    expenses: [
      { id: "e1", businessId: "biz-a", occurredOn: new Date("2026-08-11"), description: "Lumber", amount: 50, category: "MATERIALS", vendor: "Depot", jobId, recurring: false },
      { id: "e2", businessId: "biz-a", occurredOn: new Date("2026-08-11"), description: "Fuel", amount: 30, category: "GAS_FUEL", vendor: "Shell", jobId, recurring: false },
    ],
    estimateLines: [
      { estimateId: "est-1", type: "LABOR", quantity: 8, total: 160, fromApprovedVersion: true },
      { estimateId: "est-1", type: "MATERIAL", quantity: 1, total: 40, fromApprovedVersion: true },
    ],
    laborBurden: { burdenRate: 0.1, targetGrossMarginRate: 0.4, notes: "payroll tax" },
  });
  const profit = calculateJobProfitability(jobId, jobSource);
  check("Contracted revenue is approved estimate + approved change orders", profit?.contractedRevenue === 1200);
  check("Billed revenue is SENT + PAID invoices", profit?.billedRevenue === 1200);
  check("Collected revenue ignores the unpaid SENT invoice", profit?.collectedRevenue === 400);
  check("Unpaid invoice value is not collected cash", collectedRevenueForJob({ jobId, invoices: jobSource.invoices, payments: jobSource.payments }) === 400);
  check("Labor hours come from approved time", profit?.laborHours === 10);
  check("Direct labor cost is recorded wage only", profit?.directLaborCost === 200 && profit?.recordedWageLaborCost === 200);
  check("Burden is applied only because it was configured", profit?.laborBurden.burdenAmount === 20 && profit?.laborBurden.laborCostWithBurden === 220);
  check("Materials and other direct expenses are split", profit?.materialsDirectExpense === 50 && profit?.otherAllocatedDirectExpense === 30);
  check("Recorded direct cost excludes owner burden assumption", profit?.recordedDirectCost === 280 && profit?.knownTotalDirectCost === 280);
  check("Burden-adjusted scenario is separate from recorded cost", profit?.burdenAdjustedDirectCost === 300);
  check("Gross profit is billed minus recorded direct cost", profit?.grossProfit === 920);
  check("Gross margin percent is 76.67 on billed revenue", profit?.grossMarginPct === 76.67);
  check("Generic LABOR quantity is not estimated hours", profit?.estimateActual.estimatedLaborHours === null && profit?.estimateActual.laborHoursVariance === null);
  check("LABOR line total is customer labor charge, not estimated cost", profit?.estimateActual.customerLaborCharge === 160 && profit?.estimateActual.estimatedLaborCost === null && profit?.estimateActual.laborCostVariance === null);
  check("MATERIAL line total is customer material charge, not supplier cost", profit?.estimateActual.customerMaterialCharge === 40 && profit?.estimateActual.estimatedMaterialCost === null);
  check("Customer charge labels stay truthful", /customer labor charge/i.test(CUSTOMER_LABOR_CHARGE_LABEL));
  check("Service attribution uses the request catalog item", profit?.completeness.serviceAttributed === true && profit?.catalogItemId === "svc-1");
  check("Unpaid invoice completeness flag is set", profit?.completeness.unpaidInvoicePresent === true);

  const noBurden = calculateJobProfitability(jobId, { ...jobSource, laborBurden: emptyLaborBurdenConfig() });
  check("Without configured burden, cost stays wage-only + expenses", noBurden?.knownTotalDirectCost === 280 && noBurden?.laborBurden.burdenSource === "none");

  console.log("\nSTATIC — Cash flow, receivables, aggregations");
  const cash = buildKnownCashFlow({
    collectedPayments: [{ amount: 400 }],
    recordedExpenses: [{ amount: 80 }],
    processedPayroll: [{ authorizedGrossLaborAmount: 50 }],
  });
  check("Projected bank balance stays null", cash.projectedBalance === null && cash.bankConnected === false);
  check("Known inflows are collected payments only", cash.knownInflows === 400 && cash.collectedCustomerPayments === 400);
  check("SENT invoices are not an input to known cash in", !("outstandingInvoices" in cash));
  check("Known outflows are recorded expenses only", cash.knownOutflows === 80);
  check("Processed payroll gross is shown separately and not treated as bank cash out", cash.processedPayrollGrossLabor === 50 && cash.processedPayrollOutflows === 0);
  check("Known net does not subtract payroll gross", cash.netKnown === 320 && /not included as verified bank cash movement/i.test(PAYROLL_GROSS_NOT_CASH_MESSAGE));

  const sentIsNotCash = buildKnownCashFlow({
    collectedPayments: [],
    recordedExpenses: [],
    processedPayroll: [{ authorizedGrossLaborAmount: 10 }],
  });
  check("A sent invoice is not required to compute cash flow", sentIsNotCash.knownInflows === 0 && sentIsNotCash.knownOutflows === 0 && sentIsNotCash.processedPayrollGrossLabor === 10);

  check("45 days ages into 31-60", agingBucketForDays(45) === "31-60");
  check("90 days stays in 61-90", agingBucketForDays(90) === "61-90");
  check("91 days is 90+", agingBucketForDays(91) === "90+");

  const issued = new Date("2026-08-01T00:00:00Z");
  const recvSource = financeSource({
    customers: [{ id: "c1", name: "Ada", createdAt: issued }],
    invoices: [
      { id: "inv-1", businessId: "biz-a", status: "SENT", total: 100, paidAt: null, createdAt: issued, customerId: "c1", jobId: "job-1", paymentMethod: null, paymentReference: null },
      { id: "inv-paid", businessId: "biz-a", status: "PAID", total: 50, paidAt: issued, createdAt: issued, customerId: "c1", jobId: "job-1", paymentMethod: "CASH", paymentReference: null },
    ],
    payments: [{ id: "p-partial", businessId: "biz-a", customerId: "c1", jobId: "job-1", invoiceId: "inv-1", purpose: "INVOICE_BALANCE", amount: 20, method: "CASH", receivedAt: issued }],
  });
  const aging = buildReceivables(recvSource, new Date("2026-09-15T00:00:00Z"));
  check("Receivables exclude PAID invoices", aging.count === 1 && aging.rows[0]?.invoiceId === "inv-1");
  check("Balance due subtracts recorded payments", aging.rows[0]?.balanceDue === 80 && aging.totalOutstanding === 80);
  check("Due date is null because none exists", aging.rows[0]?.dueDate === null);
  check("Age uses issued date", aging.rows[0]?.ageDays === 45 && aging.rows[0]?.agingBucket === "31-60");

  const services = buildServiceProfitability([profit]);
  check("Attributed service aggregation keeps Fence repair", services.some((row) => row.catalogItemId === "svc-1" && row.jobs === 1 && row.revenue === 1200));
  const orphan = calculateJobProfitability("job-x", financeSource({
    jobs: [{ id: "job-x", status: "COMPLETED", createdAt: new Date(), customerId: "c1", estimateId: null }],
    invoices: [{ id: "i-x", businessId: "biz-a", status: "PAID", total: 10, paidAt: new Date(), createdAt: new Date(), customerId: "c1", jobId: "job-x", paymentMethod: null, paymentReference: null }],
  }));
  const mixed = buildServiceProfitability([profit, orphan].filter(Boolean));
  check("Unattributed jobs are not fabricated onto a service", mixed.some((row) => row.attributed === false && row.jobs === 1));

  const customers = buildCustomerProfitability(jobSource, [profit], aging.rows);
  check("Customer invoiced includes sent + paid", customers[0]?.invoiced === 1200);
  check("Customer collected ignores unpaid remainder", customers[0]?.collected === 400);
  check("Customer outstanding uses receivable balance", customers[0]?.outstandingReceivables === 80);

  const lifetime = buildCustomerLifetime(
    [
      { id: "c1", name: "Ada", createdAt: new Date() },
      { id: "c2", name: "Ned", createdAt: new Date() },
    ],
    [
      { customerId: "c1", status: "PAID", total: 80 },
      { customerId: "c1", status: "PAID", total: 40 },
      { customerId: "c1", status: "SENT", total: 999 },
      { customerId: "c2", status: "DRAFT", total: 10 },
    ],
    [
      { customerId: "c1", status: "COMPLETED" },
      { customerId: "c1", status: "COMPLETED" },
    ],
  );
  check("Lifetime uses PAID invoices only", lifetime[0]?.paidRevenue === 120 && lifetime[0]?.paidInvoiceCount === 2);
  check("Customer with no paid/completed activity is omitted", lifetime.every((row) => row.customerId !== "c2"));

  const priced = buildPricingRecommendations({
    jobs: Array.from({ length: PRICING_MIN_SAMPLE }, (_, index) => ({
      ...profit,
      jobId: `job-${index}`,
      status: "COMPLETED",
      grossMarginPct: 10,
      completeness: { ...profit.completeness, laborCostComplete: true },
      estimateActual: {
        ...profit.estimateActual,
        estimatedLaborHours: 4,
        estimatedLaborHoursProvenance: "calculator-hours",
        laborHoursVariance: 6,
      },
      recordedDirectCost: 280,
      knownTotalDirectCost: 280,
    })),
    services: [{
      catalogItemId: "svc-1",
      name: "Fence repair",
      jobs: 3,
      revenue: 3600,
      collectedRevenue: 1200,
      laborHours: 30,
      directCost: 900,
      grossProfit: 2700,
      grossMargin: 10,
      averageTicket: 1200,
      estimateVariance: 100,
      jobCount: 3,
      attributed: true,
      laborCost: 600,
      jobExpense: 240,
      recordedMargin: 2700,
    }],
    laborBurden: { burdenRate: null, targetGrossMarginRate: 0.4, notes: null },
    expenseGrowthPercent: 40,
    currentExpenses: 140,
    priorExpenses: 100,
  });
  check("Under-target margin recommendation includes sample size", priced.some((row) => row.key === "under-target-margin" && row.sampleSize === 3 && row.evidence.length > 0));
  check("Labor overrun recommendation requires a trustworthy hours snapshot", priced.some((row) => row.key === "labor-exceeds-estimate" && /hours baseline/.test(row.currentResult)));
  const fakeHours = buildPricingRecommendations({
    jobs: Array.from({ length: PRICING_MIN_SAMPLE }, (_, index) => ({
      ...profit,
      jobId: `job-qty-${index}`,
      status: "COMPLETED",
      recordedDirectCost: 280,
      completeness: { ...profit.completeness, laborCostComplete: true },
      estimateActual: {
        ...profit.estimateActual,
        estimatedLaborHours: null,
        estimatedLaborHoursProvenance: "none",
        laborHoursVariance: null,
        customerLaborCharge: 500,
      },
    })),
    services: [],
    laborBurden: { burdenRate: null, targetGrossMarginRate: null, notes: null },
    expenseGrowthPercent: null,
    currentExpenses: 0,
    priorExpenses: 0,
  });
  check("Generic LABOR quantity does not create a labor-overrun signal", fakeHours.every((row) => row.key !== "labor-exceeds-estimate" && row.key !== "scheduled-duration-overrun"));
  check(
    "Pricing recommendations never claim an automatic price change",
    priced.every((row) => row.kind === "owner-review" && !/automatically change|auto-change|will update .*price/i.test(row.proposedAction)),
  );
  check("Expense growth becomes an owner-review signal", priced.some((row) => row.key === "recurring-cost-growth"));

  const patterns = detectRecurringExpensePatterns([
    { id: "a", description: "Insurance", amount: 25, category: "INSURANCE", vendor: "Insurer", recurring: true, occurredOn: new Date("2026-07-01") },
    { id: "b", description: "Insurance", amount: 25, category: "INSURANCE", vendor: "Insurer", recurring: false, occurredOn: new Date("2026-08-01") },
  ]);
  check("Recurring detection uses recorded expense history", patterns.some((row) => row.occurrenceCount === 2 && row.ownerStatus === "SUGGESTED"));

  const recs = buildBsosRecommendations({
    unpaidInvoices: { count: 1, amount: 80 },
    sentEstimates: { count: 0 },
    draftEstimates: { count: 0 },
    unscheduledJobs: { count: 0 },
    completedJobsWithoutReview: { count: 0 },
    completedJobsReadyForMarketing: { count: 0 },
    lowMarginJobs: { count: 0 },
    missingWageEntries: { count: 0 },
    availableCapacityDays: { count: 0 },
    repeatCustomers: { count: 0 },
    outsideAreaRequests: { count: 0 },
    recurringExpenses: { count: 0, amount: 0 },
    paidRevenue: { amount: 0 },
    recordedExpenses: { amount: 0 },
    agedReceivables: { count: 1, amount: 80 },
    lowMarginServices: { count: 1 },
    estimateLaborOverruns: { count: 2 },
    customerConcentration: { share: 0.7, customerName: "Ada" },
  });
  check("BSOS includes aging receivables", recs.some((row) => row.key === "receivable-needs-attention"));
  check("BSOS includes service margin", recs.some((row) => row.key === "service-margin-below-target"));
  check("BSOS includes estimate labor overrun", recs.some((row) => row.key === "estimate-labor-overrun"));
  check("BSOS includes customer concentration", recs.some((row) => row.key === "high-value-customer-concentration"));

  console.log("\nROLE — Reports stay owner/admin");
  check("MEMBER does not have VIEW_REPORTS", !roleHasCapability("MEMBER", CAPABILITIES.VIEW_REPORTS));
  check("OWNER keeps VIEW_REPORTS", roleHasCapability("OWNER", CAPABILITIES.VIEW_REPORTS));
  check("ADMIN keeps VIEW_REPORTS", roleHasCapability("ADMIN", CAPABILITIES.VIEW_REPORTS));
  check("Reports nav is hidden from MEMBER", !visibleAppNav("MEMBER").some((item) => item.href === "/reports"));

  console.log("\nDB — Tenant isolation and recorded facts");
  const businessA = await prisma.business.create({
    data: { name: "Alpha Finance", slug: `alpha-fin-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Finance", slug: `beta-fin-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerA = await prisma.user.create({
    data: { name: "Ada Owner", email: `ada-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberA = await prisma.user.create({
    data: { name: "Mia Member", email: `mia-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerA.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberA.id, businessId: businessA.id, role: "MEMBER" },
  });
  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada" },
  });
  const paidInvoice = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "PAID",
      total: 200,
      paidAt: new Date("2026-08-20"),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "SENT",
      total: 75,
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessB.id,
      status: "PAID",
      total: 9999,
      paidAt: new Date(),
    },
  });
  await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      invoiceId: paidInvoice.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(200),
      method: "CASH",
      receivedAt: new Date("2026-08-20"),
    },
  });
  await prisma.expense.create({
    data: {
      businessId: businessA.id,
      occurredOn: new Date("2026-08-21"),
      description: "Insurance",
      amount: 25,
      category: "OTHER",
      vendor: "Insurer",
      recurring: true,
    },
  });
  await prisma.payrollRun.create({
    data: {
      businessId: businessA.id,
      payPeriodStart: new Date("2026-08-01"),
      payPeriodEnd: new Date("2026-08-08"),
      status: "AUTHORIZED",
      authorizedGrossLaborAmount: 999,
    },
  });
  await prisma.payrollRun.create({
    data: {
      businessId: businessB.id,
      payPeriodStart: new Date("2026-08-01"),
      payPeriodEnd: new Date("2026-08-08"),
      status: "PROCESSED",
      processedAt: new Date("2026-08-09"),
      authorizedGrossLaborAmount: 5000,
    },
  });

  const sourceA = await loadFinancialSource(prisma, businessA.id);
  const sourceB = await loadFinancialSource(prisma, businessB.id);
  check("Tenant A does not load B's paid invoice", sourceA.invoices.every((row) => row.businessId === businessA.id));
  check("Tenant B does not load A's SENT invoice", sourceB.invoices.every((row) => row.businessId === businessB.id));
  check("Tenant A does not load B processed payroll", sourceA.payrollRuns.every((row) => row.authorizedGrossLaborAmount !== 5000));
  check("Browser businessId is not used by the loader — only the workspace id", sourceA.businessId === businessA.id);

  const range = resolveReportRange("all", undefined, undefined, new Date());
  const report = buildReport(sourceA, range);
  const intel = buildFinancialIntelligence(sourceA, report, new Date("2026-09-01"));
  check("Bank and accounting stay Not Connected", intel.bankConnected === false && intel.accountingConnected === false);
  check("Projected balance is never invented", intel.cashFlow.projectedBalance === null);
  check("Outstanding receivables use SENT invoices", intel.outstandingReceivables.count === 1 && intel.outstandingReceivables.amount === 75);
  check("Collected cash uses the payment, not the SENT invoice", intel.cashFlow.collectedCustomerPayments === 200 && intel.cashFlow.knownInflows === 200);
  check("Authorized payroll is not treated as cash out", intel.cashFlow.processedPayrollOutflows === 0);
  check("Customer lifetime includes Ada's paid revenue", intel.customerLifetime.some((row) => row.name === "Ada" && row.paidRevenue === 200));
  check("Recurring expenses appear from recorded rows", intel.recurringExpenses.some((row) => row.description === "Insurance"));
  check("Job profitability is labeled whole-job for activity in range", intel.jobMarginKind === "whole-job-for-activity-in-range" && intel.jobMarginLabel === WHOLE_JOB_RANGE_LABEL);

  const signals = financialSignalsForBsos(intel);
  check("BSOS hooks are recorded facts", signals.every((row) => row.kind === "fact"));
  check("Outstanding receivables become a BSOS fact", signals.some((row) => row.key === "outstanding-receivables"));

  const memberAccess = makeAccess(businessA.id, "MEMBER", memberMem.id);
  let memberBlocked = false;
  try {
    requireBusinessCapability(memberAccess, CAPABILITIES.VIEW_REPORTS);
  } catch (error) {
    memberBlocked = error instanceof ForbiddenError;
  }
  check("MEMBER cannot read whole-business financial capability", memberBlocked);

  let memberSaveBlocked = false;
  try {
    await saveLaborBurdenSetting(prisma, memberAccess, { burdenRate: "15" });
  } catch (error) {
    memberSaveBlocked = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  check("MEMBER cannot write labor burden", memberSaveBlocked);

  const ownerAccess = makeAccess(businessA.id, "OWNER", ownerMem.id);
  await prisma.businessSaasSubscription.create({
    data: {
      businessId: businessA.id,
      status: "active",
      planCode: "FOUNDER",
      legacyExempt: true,
    },
  });
  const saved = await saveLaborBurdenSetting(prisma, ownerAccess, { burdenRate: "12.5", targetGrossMarginRate: "40" });
  check("Owner can persist optional burden without inventing a default", Number(saved.burdenRate) === 0.125 && Number(saved.targetGrossMarginRate) === 0.4);

  const reloaded = await loadFinancialSource(prisma, businessA.id);
  check("Reloaded burden matches the saved rate", reloaded.laborBurden.burdenRate === 0.125);
  check("Historical invoices remain after burden save (downgrade-safe records)", reloaded.invoices.length === 2);

  const betaOnly = await loadFinancialSource(prisma, businessB.id);
  check("Business B cannot see A's burden setting", betaOnly.laborBurden.burdenRate === null);
  check("Business B cannot see A's payment", betaOnly.payments.length === 0);

  console.log("\nSTATIC — Estimate-vs-actual fixed-price labor is not hours or cost");
  const hoursDescription = joinLineDescription("Calculator labor", null, {
    calculatorId: "custom-variable-scope",
    inputs: { estimatedLaborHours: 4 },
    rates: {},
  });
  const fixedPrice = calculateJobProfitability("job-fixed", financeSource({
    customers: [{ id: "c1", name: "Ada", createdAt: new Date("2026-01-01") }],
    jobs: [{ id: "job-fixed", status: "COMPLETED", createdAt: new Date("2026-01-01"), customerId: "c1", estimateId: "est-fixed", scheduledDurationMinutes: 120 }],
    estimates: [{ id: "est-fixed", status: "APPROVED", total: 500, createdAt: new Date("2026-01-01"), customerId: "c1", serviceRequestId: null }],
    estimateLines: [
      { estimateId: "est-fixed", type: "LABOR", quantity: 1, total: 500, fromApprovedVersion: true },
      { estimateId: "est-fixed", type: "MATERIAL", quantity: 1, total: 250, fromApprovedVersion: true },
    ],
    invoices: [{ id: "inv-fixed", businessId: "biz-a", status: "PAID", total: 500, paidAt: new Date("2026-01-02"), createdAt: new Date("2026-01-02"), customerId: "c1", jobId: "job-fixed", paymentMethod: null, paymentReference: null }],
    payments: [{ id: "pay-fixed", businessId: "biz-a", customerId: "c1", jobId: "job-fixed", invoiceId: "inv-fixed", purpose: "INVOICE_BALANCE", amount: 500, method: "CASH", receivedAt: new Date("2026-01-02") }],
    approvedTimeEntries: [
      { id: "t-fixed", membershipId: "m1", jobId: "job-fixed", activityType: "JOB", startedAt: new Date("2026-01-02"), approvedHours: 6, approvedLaborCost: 180 },
    ],
  }));
  check("Fixed-price LABOR quantity 1 is not estimated labor hours", fixedPrice?.estimateActual.estimatedLaborHours === null);
  check("Fixed-price LABOR $500 is customer charge, not estimated labor cost", fixedPrice?.estimateActual.customerLaborCharge === 500 && fixedPrice?.estimateActual.estimatedLaborCost === null);
  check("MATERIAL $250 is customer material charge, not supplier cost", fixedPrice?.estimateActual.customerMaterialCharge === 250 && fixedPrice?.estimateActual.estimatedMaterialCost === null);
  check("Actual 6 hours / $180 wage does not create fake cost variance", fixedPrice?.estimateActual.laborHoursVariance === null && fixedPrice?.estimateActual.laborCostVariance === null && fixedPrice?.estimateActual.totalCostVariance === null);
  check("Scheduled duration is labeled planned/scheduled, not estimate hours", fixedPrice?.estimateActual.scheduledDurationMinutes === 120 && /planned\/scheduled duration/i.test(fixedPrice?.estimateActual.scheduledDurationLabel ?? ""));
  const snapshotHours = calculateJobProfitability("job-snap", financeSource({
    customers: [{ id: "c1", name: "Ada", createdAt: new Date("2026-01-01") }],
    jobs: [{ id: "job-snap", status: "COMPLETED", createdAt: new Date("2026-01-01"), customerId: "c1", estimateId: "est-snap" }],
    estimates: [{ id: "est-snap", status: "APPROVED", total: 400, createdAt: new Date("2026-01-01"), customerId: "c1", serviceRequestId: null }],
    estimateLines: [
      { estimateId: "est-snap", type: "LABOR", quantity: 1, total: 400, description: hoursDescription, fromApprovedVersion: true },
    ],
    approvedTimeEntries: [
      { id: "t-snap", membershipId: "m1", jobId: "job-snap", activityType: "JOB", startedAt: new Date("2026-01-02"), approvedHours: 6, approvedLaborCost: 180 },
    ],
  }));
  check("Calculator hours snapshot is the only hours baseline", snapshotHours?.estimateActual.estimatedLaborHours === 4 && snapshotHours?.estimateActual.estimatedLaborHoursProvenance === "calculator-hours");

  console.log("\nSTATIC — Canonical collected revenue and remaining balances");
  const mixedJob = {
    jobId: "job-mix",
    invoices: [
      { id: "inv-a", status: "PAID", total: 100, jobId: "job-mix", customerId: "c1" },
      { id: "inv-b", status: "PAID", total: 75, jobId: "job-mix", customerId: "c1" },
    ],
    payments: [
      { id: "pay-a", amount: 100, invoiceId: "inv-a", jobId: "job-mix", customerId: "c1", receivedAt: new Date() },
    ],
  };
  check(
    "Mixed payment + legacy PAID on the same job collects both",
    collectedRevenueForJob(mixedJob) === 175,
  );
  const noJobCustomer = collectedRevenueForCustomer({
    customerId: "c-partial",
    invoices: [{ id: "inv-partial", status: "PAID", total: 100, customerId: "c-partial", jobId: null }],
    payments: [{ id: "pay-partial", amount: 40, invoiceId: "inv-partial", jobId: null, customerId: "c-partial", receivedAt: new Date() }],
  });
  check("Customer PAID invoice with a $40 Payment and no job collects $40, not $100", noJobCustomer === 40);
  const once = collectedRevenueForJob({
    jobId: "job-once",
    invoices: [{ id: "inv-once", status: "PAID", total: 50, jobId: "job-once", customerId: "c1" }],
    payments: [
      { id: "pay-once", amount: 50, invoiceId: "inv-once", jobId: "job-once", customerId: "c1", receivedAt: new Date() },
      { id: "pay-once", amount: 50, invoiceId: "inv-once", jobId: "job-once", customerId: "c1", receivedAt: new Date() },
    ],
  });
  check("One Payment linked through job and invoice paths is counted once", once === 50);
  const sentPartial = invoiceBalanceDue(
    { id: "inv-sent-1000", total: 1000 },
    [{ id: "pay-400", amount: 400, invoiceId: "inv-sent-1000", jobId: "job-1", customerId: "c1", receivedAt: new Date() }],
  );
  check("SENT $1000 with $400 collected has $600 remaining, not $1000", sentPartial === 600);
  const reconSource = financeSource({
    jobs: [{ id: "job-mix", status: "COMPLETED", createdAt: new Date(), customerId: "c1", estimateId: null }],
    customers: [{ id: "c1", name: "Ada", createdAt: new Date() }, { id: "c-partial", name: "Ned", createdAt: new Date() }],
    invoices: [
      { id: "inv-a", businessId: "biz-a", status: "PAID", total: 100, paidAt: new Date(), createdAt: new Date(), customerId: "c1", jobId: "job-mix", paymentMethod: null, paymentReference: null },
      { id: "inv-b", businessId: "biz-a", status: "PAID", total: 75, paidAt: new Date(), createdAt: new Date(), customerId: "c1", jobId: "job-mix", paymentMethod: null, paymentReference: null },
      { id: "inv-partial", businessId: "biz-a", status: "PAID", total: 100, paidAt: new Date(), createdAt: new Date(), customerId: "c-partial", jobId: null, paymentMethod: null, paymentReference: null },
    ],
    payments: [
      { id: "pay-a", businessId: "biz-a", customerId: "c1", jobId: "job-mix", invoiceId: "inv-a", purpose: "INVOICE_BALANCE", amount: 100, method: "CASH", receivedAt: new Date() },
      { id: "pay-partial", businessId: "biz-a", customerId: "c-partial", jobId: null, invoiceId: "inv-partial", purpose: "INVOICE_BALANCE", amount: 40, method: "CASH", receivedAt: new Date() },
    ],
  });
  const recon = reconcileCollectedRevenue(reconSource);
  check("Global collected cash reconciles to job-attributed plus unattributed", recon.reconciles && recon.totalCollected === 215 && recon.attributedToJobs === 175 && recon.unattributedCollected === 40);
  check("Invoice-set collected matches the same 215", collectedRevenueForInvoices(reconSource.invoices, reconSource.payments) === 215);
  const sentJob = calculateJobProfitability("job-sent", financeSource({
    jobs: [{ id: "job-sent", status: "COMPLETED", createdAt: new Date(), customerId: "c1", estimateId: null }],
    invoices: [{ id: "inv-sent-1000", businessId: "biz-a", status: "SENT", total: 1000, paidAt: null, createdAt: new Date(), customerId: "c1", jobId: "job-sent", paymentMethod: null, paymentReference: null }],
    payments: [{ id: "pay-400", businessId: "biz-a", customerId: "c1", jobId: "job-sent", invoiceId: "inv-sent-1000", purpose: "INVOICE_BALANCE", amount: 400, method: "CASH", receivedAt: new Date() }],
  }));
  check("Job outstanding uses remaining balance after partial collection", sentJob?.outstandingReceivable === 600 && sentJob?.collectedRevenue === 400);

  console.log("\nSTATIC — Recurring evidence, chronology, CSV labels");
  const homeDepot = detectRecurringExpensePatterns([
    { id: "hd1", description: "2x4 lumber", amount: 48, category: "MATERIALS", vendor: "Home Depot", recurring: false, occurredOn: new Date("2026-07-01") },
    { id: "hd2", description: "Exterior paint", amount: 62, category: "MATERIALS", vendor: "Home Depot", recurring: false, occurredOn: new Date("2026-07-20") },
  ]);
  check("Two unrelated Home Depot material purchases are not a recurring suggestion", homeDepot.length === 0);
  const insurance = detectRecurringExpensePatterns([
    { id: "ins1", description: "Liability insurance", amount: 25, category: "INSURANCE", vendor: "Insurer", recurring: false, occurredOn: new Date("2026-06-01") },
    { id: "ins2", description: "Liability insurance", amount: 25, category: "INSURANCE", vendor: "Insurer", recurring: false, occurredOn: new Date("2026-07-01") },
    { id: "ins3", description: "Liability insurance", amount: 25, category: "INSURANCE", vendor: "Insurer", recurring: false, occurredOn: new Date("2026-08-01") },
  ]);
  check("Three matching monthly insurance charges become a suggestion", insurance.some((row) => row.occurrenceCount === 3 && row.cadence === "monthly" && row.why.some((line) => /monthly/i.test(line))));
  const explicit = detectRecurringExpensePatterns([
    { id: "soft1", description: "Design software", amount: 30, category: "SOFTWARE", vendor: "Adobe", recurring: true, occurredOn: new Date("2026-08-01") },
  ]);
  check("Explicit owner recurring flag becomes a suggestion", explicit.some((row) => row.cadence === "explicit-flag" && row.why.some((line) => /explicitly marked recurring/i.test(line))));
  const irregular = detectRecurringExpensePatterns([
    { id: "c1", description: "Deck contractor", amount: 900, category: "SUBCONTRACTOR", vendor: "Bob", recurring: false, occurredOn: new Date("2026-01-01") },
    { id: "c2", description: "Fence contractor", amount: 1400, category: "SUBCONTRACTOR", vendor: "Bob", recurring: false, occurredOn: new Date("2026-03-15") },
    { id: "c3", description: "Shed contractor", amount: 2100, category: "SUBCONTRACTOR", vendor: "Bob", recurring: false, occurredOn: new Date("2026-08-02") },
  ]);
  check("Irregular one-off contractor spend is not a recurring suggestion", irregular.length === 0);

  const laterLow = Array.from({ length: 3 }, (_, index) => ({
    ...profit,
    jobId: `aaa-recent-${index}`,
    status: "COMPLETED",
    grossMarginPct: 10,
    burdenAdjustedMarginPct: 10,
    recordedDirectCost: 280,
    financialActivityAt: new Date("2026-09-01"),
    completeness: { ...profit.completeness, laborCostComplete: true },
  }));
  const earlierHigh = Array.from({ length: 3 }, (_, index) => ({
    ...profit,
    jobId: `zzz-older-${index}`,
    status: "COMPLETED",
    grossMarginPct: 40,
    burdenAdjustedMarginPct: 40,
    recordedDirectCost: 280,
    financialActivityAt: new Date("2026-01-01"),
    completeness: { ...profit.completeness, laborCostComplete: true },
  }));
  const datedErosion = buildPricingRecommendations({
    jobs: [...laterLow, ...earlierHigh],
    services: [],
    laborBurden: { burdenRate: null, targetGrossMarginRate: null, notes: null },
    expenseGrowthPercent: null,
    currentExpenses: 0,
    priorExpenses: 0,
  });
  check("Margin erosion follows financial-activity dates, not lexical job IDs", datedErosion.some((row) => row.key === "margin-erosion" && /financial-activity date/i.test(row.evidence.join(" "))));
  const sameDay = buildPricingRecommendations({
    jobs: [...laterLow, ...earlierHigh].map((job) => ({ ...job, financialActivityAt: new Date("2026-06-01") })),
    services: [],
    laborBurden: { burdenRate: null, targetGrossMarginRate: null, notes: null },
    expenseGrowthPercent: null,
    currentExpenses: 0,
    priorExpenses: 0,
  });
  check("No recent-margin-erosion claim without distinct chronology", sameDay.every((row) => row.key !== "margin-erosion"));

  const csv = jobProfitabilityCsvRows(intel);
  check("Job CSV states whole-job range semantics", csv.headers.includes("Range semantics") && csv.rows.every((row) => row.at(-1) === WHOLE_JOB_RANGE_LABEL));
  check("Job CSV separates recorded wage from burden assumption", csv.headers.includes("Recorded wage labor cost") && csv.headers.includes("Owner-configured burden %"));

  console.log("\nDB — Owner review, tamper-proof facts, entitlements");
  const adminUser = await prisma.user.create({
    data: { name: "Ann Admin", email: `ann-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const adminAccess = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const ownerB = await prisma.user.create({
    data: { name: "Bea Owner", email: `bea-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerBMem = await prisma.membership.create({
    data: { userId: ownerB.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerBAccess = makeAccess(businessB.id, "OWNER", ownerBMem.id);
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessB.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });

  await prisma.expense.createMany({
    data: [
      { businessId: businessA.id, occurredOn: new Date("2026-06-01"), description: "Liability insurance", amount: 25, category: "INSURANCE", vendor: "Insurer", recurring: false },
      { businessId: businessA.id, occurredOn: new Date("2026-07-01"), description: "Liability insurance", amount: 25, category: "INSURANCE", vendor: "Insurer", recurring: false },
      { businessId: businessA.id, occurredOn: new Date("2026-08-01"), description: "Liability insurance", amount: 25, category: "INSURANCE", vendor: "Insurer", recurring: false },
    ],
  });
  const insuranceKey = "INSURANCE::insurer::liability insurance";
  let memberReviewBlocked = false;
  try {
    await reviewRecurringExpensePattern(prisma, memberAccess, { patternKey: insuranceKey, ownerStatus: "CONFIRMED" });
  } catch (error) {
    memberReviewBlocked = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  check("MEMBER cannot confirm a recurring pattern", memberReviewBlocked);
  let adminReviewBlocked = false;
  try {
    await reviewRecurringExpensePattern(prisma, adminAccess, { patternKey: insuranceKey, ownerStatus: "CONFIRMED" });
  } catch (error) {
    adminReviewBlocked = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  check("ADMIN cannot owner-confirm a recurring pattern", adminReviewBlocked);
  let staleBlocked = false;
  try {
    await reviewRecurringExpensePattern(prisma, ownerAccess, { patternKey: "INSURANCE::tampered::$25000", ownerStatus: "CONFIRMED" });
  } catch (error) {
    staleBlocked = error instanceof FinancialIntelligenceError && /unknown or stale/i.test(error.message);
  }
  check("Hidden-field / stale patternKey tampering is rejected", staleBlocked);
  let crossTenantBlocked = false;
  try {
    await reviewRecurringExpensePattern(prisma, ownerBAccess, { patternKey: insuranceKey, ownerStatus: "CONFIRMED" });
  } catch (error) {
    crossTenantBlocked = error instanceof FinancialIntelligenceError || error instanceof ForbiddenError;
  }
  check("Cross-tenant recurring review is denied", crossTenantBlocked);
  const confirmed = await reviewRecurringExpensePattern(prisma, ownerAccess, { patternKey: insuranceKey, ownerStatus: "CONFIRMED" });
  check("Owner confirm persists server-recomputed $25, not a browser amount", Number(confirmed.suggestedAmount) === 25 && confirmed.confirmedByMembershipId === ownerMem.id && confirmed.ownerStatus === "CONFIRMED");

  const adminBurden = await saveLaborBurdenSetting(prisma, adminAccess, { burdenRate: "20", targetGrossMarginRate: "99" });
  check("ADMIN may change burden but cannot rewrite owner target margin", Number(adminBurden.burdenRate) === 0.2 && Number(adminBurden.targetGrossMarginRate) === 0.4);
  const audits = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessA.id, settingArea: "financial-intelligence" },
    orderBy: { changedAt: "asc" },
  });
  check("Burden/target changes write old and new values with actor", audits.some((row) => row.settingKey === "laborBurden.burdenRate" && row.changedByMembershipId === adminMem.id && String(row.newValue).includes("0.2")));

  const starterBiz = await prisma.business.create({
    data: { name: "Starter Shop", slug: `starter-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: starterBiz.id, status: "active", planCode: "STARTER" },
  });
  check("STARTER cannot access REPORTING_INSIGHTS", (await hasProductCapability(prisma, starterBiz.id, PRODUCT_CAPABILITIES.REPORTING_INSIGHTS)) === false);
  let starterDenied = false;
  try {
    await requireProductCapability(prisma, starterBiz.id, PRODUCT_CAPABILITIES.REPORTING_INSIGHTS);
  } catch (error) {
    starterDenied = /does not include/i.test(error.message);
  }
  check("STARTER requireProductCapability refuses Reporting Insights", starterDenied);
  check("Founder keeps REPORTING_INSIGHTS", (await hasProductCapability(prisma, businessA.id, PRODUCT_CAPABILITIES.REPORTING_INSIGHTS)) === true);

  await prisma.businessSaasSubscription.update({
    where: { businessId: businessA.id },
    data: { status: "canceled" },
  });
  check("Cancelled Founder still has REPORTING_INSIGHTS for retained history", (await hasProductCapability(prisma, businessA.id, PRODUCT_CAPABILITIES.REPORTING_INSIGHTS)) === true);
  const afterCancel = await loadFinancialSource(prisma, businessA.id);
  check("Cancelled/downgrade data preservation keeps invoices and payments", afterCancel.invoices.length >= 2 && afterCancel.payments.length >= 1);

  const starterFacts = {
    unpaidInvoices: { count: 0, amount: 0 },
    sentEstimates: { count: 0 },
    draftEstimates: { count: 0 },
    unscheduledJobs: { count: 0 },
    completedJobsWithoutReview: { count: 0 },
    completedJobsReadyForMarketing: { count: 0 },
    lowMarginJobs: { count: 0 },
    missingWageEntries: { count: 0 },
    availableCapacityDays: { count: 0 },
    repeatCustomers: { count: 0 },
    outsideAreaRequests: { count: 0 },
    recurringExpenses: { count: 0, amount: 0 },
    paidRevenue: { amount: 0 },
    recordedExpenses: { amount: 0 },
  };
  const starterBsos = buildBsosRecommendations(starterFacts);
  check("BSOS without insights facts does not invent reporting-only signals", starterBsos.every((row) => !["receivable-needs-attention", "service-margin-below-target", "estimate-labor-overrun", "high-value-customer-concentration"].includes(row.key)));

  const bsosPartial = financialSignalsForBsos({
    ...intel,
    outstandingReceivables: { amount: 600, count: 1 },
    jobProfitability: [sentJob].filter(Boolean),
  });
  check("BSOS outstanding signal uses remaining balances already computed", bsosPartial.some((row) => row.key === "outstanding-receivables"));

  console.log(failures === 0 ? "\nAll financial-intelligence checks passed." : `\n${failures} financial-intelligence check(s) failed.`);
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

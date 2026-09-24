/**
 * Financial intelligence over recorded TBBT figures only.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-financial-intelligence.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { buildReport, resolveReportRange } = await import("@/lib/reports");
const { loadReportSource } = await import("@/lib/reports-data");
const {
  ACCOUNTING_NOT_CONNECTED_MESSAGE,
  BANK_NOT_CONNECTED_MESSAGE,
  CASH_FLOW_RECORDED_ONLY_MESSAGE,
  buildCustomerLifetime,
  buildFinancialIntelligence,
  buildKnownCashFlow,
  estimateConversionFromSource,
  financialSignalsForBsos,
} = await import("@/lib/financial-intelligence");

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
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

try {
  console.log("\nSTATIC — Financial intelligence honesty");
  check("Banking is Not Connected", /Not Connected/.test(BANK_NOT_CONNECTED_MESSAGE));
  check("Accounting is Not Connected", /Not Connected/.test(ACCOUNTING_NOT_CONNECTED_MESSAGE));
  check("Cash-flow message refuses an assumed bank balance", /No bank balance/.test(CASH_FLOW_RECORDED_ONLY_MESSAGE));

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

  const cash = buildKnownCashFlow({
    outstandingInvoices: [{ total: 100 }, { total: 50 }],
    futureExpenses: [{ amount: 20 }],
    authorizedPayroll: [{ authorizedGrossLaborAmount: 30 }],
  });
  check("Projected bank balance stays null", cash.projectedBalance === null && cash.bankConnected === false);
  check("Known inflows are recorded SENT totals only", cash.knownInflows === 150);
  check("Known outflows are recorded future expenses + authorized payroll", cash.knownOutflows === 50);
  check("Net known is inflows minus recorded outflows", cash.netKnown === 100);

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
  check("Repeat flag uses recorded completed jobs or paid invoices", lifetime[0]?.isRepeat === true);
  check("Customer with no paid/completed activity is omitted", lifetime.every((row) => row.customerId !== "c2"));

  const businessA = await prisma.business.create({
    data: { name: "Alpha Finance", slug: `alpha-fin-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Finance", slug: `beta-fin-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada" },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "PAID",
      total: 200,
      paidAt: new Date(),
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
  await prisma.expense.create({
    data: {
      businessId: businessA.id,
      occurredOn: new Date("2099-01-01"),
      description: "Future insurance",
      amount: 25,
      category: "OTHER",
      vendor: "Insurer",
      recurring: true,
    },
  });

  const sourceA = await loadReportSource(prisma, businessA.id);
  const sourceB = await loadReportSource(prisma, businessB.id);
  check("Tenant A does not load B's paid invoice", sourceA.invoices.every((row) => row.businessId === businessA.id));
  check("Tenant B does not load A's SENT invoice", sourceB.invoices.every((row) => row.businessId === businessB.id));
  check("Recurring expense flag is loaded from the recorded row", sourceA.expenses.some((row) => row.recurring && row.description === "Future insurance"));

  const range = resolveReportRange("all", undefined, undefined, new Date());
  const report = buildReport(sourceA, range);
  const intel = buildFinancialIntelligence(sourceA, report, new Date("2026-09-01"));
  check("Job margin is a selected-range snapshot, not a dated trend", intel.jobMarginKind === "selected-range-snapshot");
  check(
    "Job margin snapshot uses the selected report range label",
    intel.jobMarginSnapshot.every((row) => row.key === "selected-range" && row.label === report.range.label),
  );
  check("Bank and accounting stay Not Connected", intel.bankConnected === false && intel.accountingConnected === false);
  check("Projected balance is never invented", intel.cashFlow.projectedBalance === null);
  check("Outstanding receivables use SENT invoices", intel.outstandingReceivables.count === 1 && intel.outstandingReceivables.amount === 75);
  check("Recurring expenses appear from recorded rows", intel.recurringExpenses.some((row) => row.description === "Future insurance"));
  check("Known future outflow includes the recorded future expense", intel.cashFlow.knownOutflows === 25);
  check("Customer lifetime includes Ada's paid revenue", intel.customerLifetime.some((row) => row.name === "Ada" && row.paidRevenue === 200));

  const signals = financialSignalsForBsos(intel);
  check("BSOS hooks are recorded facts", signals.every((row) => row.kind === "fact"));
  check("Outstanding receivables become a BSOS fact", signals.some((row) => row.key === "outstanding-receivables"));

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

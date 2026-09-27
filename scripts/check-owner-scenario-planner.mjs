/**
 * OWNER-only deterministic scenario planner proofs.
 *
 * Proves recorded facts vs forecasts, unpaid ≠ cash, unknown bank
 * balance, no tax/accounting/price writes, authorization, isolation,
 * and bounded reads.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-owner-scenario-planner.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for scenario planner checks.");
  process.exit(generateEarly.status ?? 1);
}

const { CAPABILITIES, ForbiddenError, roleHasCapability, canAccessManagementConsole } = await import(
  "@/lib/authorization"
);
const { visibleAppNav, APP_NAV } = await import("@/lib/nav");
const { ACCOUNTING_NOT_CONNECTED_MESSAGE, BANKING_NOT_CONNECTED_MESSAGE } = await import(
  "@/lib/finance-connections"
);
const {
  ACCOUNTING_NOT_CLAIMED_MESSAGE,
  ASSUMPTION_SET_KIND,
  ASSUMPTION_SET_NOT_FOUND_MESSAGE,
  BANK_BALANCE_UNKNOWN_MESSAGE,
  COMPARE_SAME_FACTS_MESSAGE,
  FIX_ASSUMPTIONS_BEFORE_SAVE_MESSAGE,
  FORECAST_DELTA_MESSAGE,
  FORECAST_KIND,
  FORECAST_NOT_FACT_MESSAGE,
  INCOMPLETE_LABOR_MARGIN_MESSAGE,
  LABOR_WAGE_NOT_BANK_CASH_MESSAGE,
  MAX_ASSUMPTION_SET_NAME_LENGTH,
  NAME_REQUIRED_MESSAGE,
  NO_AUTOMATIC_PRICE_CHANGE_MESSAGE,
  NO_TAX_CONCLUSION_MESSAGE,
  OVERHEAD_NOT_SCALED_MESSAGE,
  PLANNER_IDENTITY_PERCENT,
  PLANNER_READ_BOUND,
  PLANNER_SET_READ_BOUND,
  READ_BOUND_MESSAGE,
  RECORDED_FACT_KIND,
  SAVE_DOES_NOT_WRITE_BOOKS_MESSAGE,
  SAVED_SET_NOT_FACT_MESSAGE,
  SCENARIO_PLANNER_PATH,
  SET_READ_BOUND_MESSAGE,
  UNPAID_NOT_CASH_MESSAGE,
  assertCanReadOwnerScenarioPlanner,
  assumptionsFromSavedSet,
  buildOwnerScenarioComparison,
  buildOwnerScenarioPlan,
  canAccessOwnerScenarioPlanner,
  isolatePlannerSource,
  isolateSameBusinessAssumptionSets,
  isolateSameBusinessExpenses,
  isolateSameBusinessInvoices,
  isolateSameBusinessPayments,
  parseAssumptionSetName,
  parseOwnerScenarioAssumptions,
  parsePlannerFactorPercent,
  scenarioPlannerHref,
  toSavedOwnerScenarioAssumptionSet,
} = await import("@/lib/owner-scenario-planner");
const {
  listOwnerScenarioAssumptionSets,
  loadOwnerScenarioAssumptionSet,
  loadOwnerScenarioPlan,
  loadOwnerScenarioPlannerSource,
  loadOwnerScenarioPlannerWorkspace,
} = await import("@/lib/owner-scenario-planner-data");
const {
  OwnerScenarioAssumptionSetError,
  assertCanWriteOwnerScenarioPlanner,
  saveOwnerScenarioAssumptionSet,
} = await import("@/lib/owner-scenario-planner-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_owner_scenario_planner_test";
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
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: businessId, timezone: "America/New_York" },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
    assertAttachable(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

const now = new Date("2026-08-20T15:00:00.000Z");

function plannerSource(overrides = {}) {
  const businessId = overrides.businessId ?? "biz-a";
  return {
    businessId,
    jobs: [],
    invoices: [],
    payments: [],
    expenses: [],
    approvedTimeEntries: [],
    customers: [],
    estimates: [],
    estimateLines: [],
    changeOrders: [],
    ...overrides,
  };
}

function identityAssumptions(overrides = {}) {
  return parseOwnerScenarioAssumptions({
    workload: "100",
    materials: "100",
    labor: "100",
    price: "100",
    ...overrides,
  });
}

const libSrc = readRepo("src/lib/owner-scenario-planner.ts");
const dataSrc = readRepo("src/lib/owner-scenario-planner-data.ts");
const opsSrc = readRepo("src/lib/owner-scenario-planner-ops.ts");
const actionSrc = readRepo("src/app/actions/owner-scenario-planner.ts");
const pageSrc = readRepo("src/app/(app)/scenario-planner/page.tsx");
const uiSrc = readRepo("src/components/owner-scenario-planner/workspace.tsx");
const schemaSrc = readRepo("prisma/schema.prisma");
const migrationSrc = readRepo(
  "prisma/migrations/20260928010000_owner_scenario_assumption_set/migration.sql",
);
const navSrc = readRepo("src/lib/nav.ts");
const packageSrc = readRepo("package.json");
const authSrc = readRepo("src/lib/authorization.ts");
const allFeatureSrc = [libSrc, dataSrc, opsSrc, actionSrc, pageSrc, uiSrc].join("\n");
const mutationPattern =
  /prisma\.(create|update|delete|upsert|updateMany|deleteMany|createMany)|\$executeRaw|\$transaction/;
const financialWritePattern =
  /prisma\.(invoice|payment|expense|job|serviceCatalogItem|estimate|lineItem)\./;

try {
  console.log("\nSTATIC — Isolation from shared files and honesty");
  check("Route is /scenario-planner", SCENARIO_PLANNER_PATH === "/scenario-planner" && pageSrc.includes("OwnerScenarioPlannerPage"));
  check("Page uses management access then OWNER gate", pageSrc.includes("requireManagementPageAccess()") && pageSrc.includes("assertCanReadOwnerScenarioPlanner"));
  check("Shared nav was not given a Scenario Planner link", !APP_NAV.some((item) => item.href === "/scenario-planner") && !navSrc.includes("/scenario-planner"));
  check("OWNER nav still has no planner destination", !visibleAppNav("OWNER").some((item) => item.href === "/scenario-planner"));
  check("No npm script was invented for this check", !packageSrc.includes("owner-scenario-planner") && !packageSrc.includes("check-owner-scenario-planner"));
  check("Authorization capability set was not expanded", !authSrc.includes("SCENARIO") && !authSrc.includes("PLANNER"));
  check("Library has no Prisma mutations", !/prisma\./.test(libSrc) && !/\$executeRaw/.test(libSrc));
  check("Data loader is read-only", dataSrc.includes("Read-only") && !mutationPattern.test(dataSrc));
  check("Page has no writes", !mutationPattern.test(pageSrc) && pageSrc.includes("loadOwnerScenarioPlannerWorkspace"));
  check("UI is a GET form, not a price write", uiSrc.includes('method="get"') && uiSrc.includes("does not") && uiSrc.includes("change prices"));
  check("Save writes only assumption-set rows", /ownerScenarioAssumptionSet\.(create|update)/.test(opsSrc) && !financialWritePattern.test(opsSrc) && !financialWritePattern.test(actionSrc));
  const setModel = schemaSrc.slice(
    schemaSrc.indexOf("model OwnerScenarioAssumptionSet"),
    schemaSrc.indexOf("model Membership"),
  );
  check("Assumption-set model stores knobs only", setModel.includes("workloadPercent") && setModel.includes("assumeUnpaidInvoicesCollect") && !/billedRevenue|collectedRevenue|projectedCashIn/.test(setModel));
  check("Migration is additive and does not rewrite books", migrationSrc.includes('CREATE TABLE IF NOT EXISTS "OwnerScenarioAssumptionSet"') && !/DROP TABLE|DELETE FROM|TRUNCATE|UPDATE\s+"Invoice"|UPDATE\s+"Payment"|UPDATE\s+"Expense"|UPDATE\s+"Job"/i.test(migrationSrc));
  check("Save action re-authorizes on the server", actionSrc.includes("requireBusinessAccess()") && actionSrc.includes("saveOwnerScenarioAssumptionSet"));
  check("UI can save, reopen, and compare named sets", uiSrc.includes("Save assumption set") && uiSrc.includes("Reopen") && uiSrc.includes("Compare forecasts"));
  check("Saved sets are labeled as knobs, not facts", /store owner knobs only/i.test(SAVED_SET_NOT_FACT_MESSAGE) && uiSrc.includes("SAVED_SET_NOT_FACT_MESSAGE"));
  check("Compare copy keeps forecasts off recorded facts", /same recorded facts/i.test(COMPARE_SAME_FACTS_MESSAGE) && /forecast-only/i.test(FORECAST_DELTA_MESSAGE));
  check("Loader queries are bounded", dataSrc.includes("take: PLANNER_READ_BOUND") && PLANNER_READ_BOUND === 200);
  check("Banking stays Not Connected", /Not Connected/.test(BANKING_NOT_CONNECTED_MESSAGE) && /Not Connected/.test(BANK_BALANCE_UNKNOWN_MESSAGE));
  check("Accounting stays Not Connected", ACCOUNTING_NOT_CLAIMED_MESSAGE === ACCOUNTING_NOT_CONNECTED_MESSAGE);
  check("Forecast is labeled as not a recorded fact", /Forecast only/.test(FORECAST_NOT_FACT_MESSAGE));
  check("Unpaid invoices are not cash", /not cash in/i.test(UNPAID_NOT_CASH_MESSAGE));
  check("No tax conclusion is offered", /does not produce tax conclusions/i.test(NO_TAX_CONCLUSION_MESSAGE));
  check("Price assumption does not write prices", /does not update catalog prices/i.test(NO_AUTOMATIC_PRICE_CHANGE_MESSAGE));
  check("Feature source does not mention tax due or filing", !/tax due|tax filing|after-tax|taxable income/i.test(allFeatureSrc));
  check("Feature source does not claim accounting is connected", !/accounting is connected|connected to (quickbooks|xero)/i.test(allFeatureSrc));

  console.log("\nSTATIC — Assumption parsing and identity math");
  check("Blank factor is 100%", parsePlannerFactorPercent("") === PLANNER_IDENTITY_PERCENT);
  check("Missing factor is 100%", parsePlannerFactorPercent(undefined) === PLANNER_IDENTITY_PERCENT);
  check("150% parses", parsePlannerFactorPercent("150") === 150);
  check("501% is rejected", parsePlannerFactorPercent("501") === null);
  check("Negative percent is rejected", parsePlannerFactorPercent("-1") === null);
  check("Non-numeric is rejected", parsePlannerFactorPercent("abc") === null);
  const invalid = parseOwnerScenarioAssumptions({ workload: "999", materials: "x" });
  check("Invalid knobs keep identity factors and report errors", invalid.workloadFactor === 1 && invalid.materialCostFactor === 1 && invalid.errors.length === 2);
  check("assumeUnpaid defaults off", identityAssumptions().assumeUnpaidInvoicesCollect === false);
  check("assumeUnpaid=1 is a forecast knob only", parseOwnerScenarioAssumptions({ assumeUnpaid: "1" }).assumeUnpaidInvoicesCollect === true);
  check("Blank assumption-set name is rejected", parseAssumptionSetName("").error === NAME_REQUIRED_MESSAGE);
  check("Too-long assumption-set name is rejected", parseAssumptionSetName("x".repeat(MAX_ASSUMPTION_SET_NAME_LENGTH + 1)).error.includes(String(MAX_ASSUMPTION_SET_NAME_LENGTH)));
  check("Valid assumption-set name is trimmed", parseAssumptionSetName("  Busy summer  ").name === "Busy summer");
  check("Reopen href uses the set id", scenarioPlannerHref({ set: "set-1" }) === "/scenario-planner?set=set-1");
  check("Compare href uses two set ids", scenarioPlannerHref({ left: "a", right: "b" }) === "/scenario-planner?left=a&right=b");

  const normal = plannerSource({
    customers: [{ id: "c1", businessId: "biz-a", name: "Ada", createdAt: now }],
    jobs: [{ id: "job-1", businessId: "biz-a", status: "COMPLETED", createdAt: now, customerId: "c1", estimateId: "est-1" }],
    estimates: [{ id: "est-1", businessId: "biz-a", status: "APPROVED", total: 1200, createdAt: now, customerId: "c1", serviceRequestId: null }],
    invoices: [
      {
        id: "inv-paid",
        businessId: "biz-a",
        status: "PAID",
        total: 1000,
        paidAt: now,
        createdAt: now,
        customerId: "c1",
        jobId: "job-1",
        paymentMethod: "CASH",
        paymentReference: null,
      },
      {
        id: "inv-sent",
        businessId: "biz-a",
        status: "SENT",
        total: 200,
        paidAt: null,
        createdAt: now,
        customerId: "c1",
        jobId: "job-1",
        paymentMethod: null,
        paymentReference: null,
      },
      {
        id: "inv-draft",
        businessId: "biz-a",
        status: "DRAFT",
        total: 9999,
        paidAt: null,
        createdAt: now,
        customerId: "c1",
        jobId: "job-1",
        paymentMethod: null,
        paymentReference: null,
      },
    ],
    payments: [
      {
        id: "pay-1",
        businessId: "biz-a",
        customerId: "c1",
        jobId: "job-1",
        invoiceId: "inv-paid",
        purpose: "INVOICE_BALANCE",
        amount: 1000,
        method: "CASH",
        receivedAt: now,
      },
    ],
    approvedTimeEntries: [
      {
        id: "t1",
        businessId: "biz-a",
        membershipId: "m1",
        jobId: "job-1",
        activityType: "JOB",
        startedAt: now,
        approvedHours: 8,
        approvedLaborCost: 200,
      },
    ],
    expenses: [
      {
        id: "e-mat",
        businessId: "biz-a",
        occurredOn: now,
        description: "Lumber",
        amount: 100,
        category: "MATERIALS",
        vendor: "Depot",
        jobId: "job-1",
        recurring: false,
      },
      {
        id: "e-oh",
        businessId: "biz-a",
        occurredOn: now,
        description: "Insurance",
        amount: 50,
        category: "INSURANCE",
        vendor: "Insurer",
        jobId: null,
        recurring: true,
      },
    ],
  });

  const identity = buildOwnerScenarioPlan(normal, identityAssumptions());
  check("Identity billed is SENT+PAID, not DRAFT", identity.recorded.billedRevenue === 1200);
  check("Identity collected ignores the unpaid SENT invoice", identity.recorded.collectedRevenue === 1000);
  check("Unpaid receivable is the SENT balance", identity.recorded.unpaidReceivable === 200 && identity.recorded.unpaidInvoiceCount === 1);
  check("Recorded cash in equals collected payments", identity.recorded.knownCashIn === 1000 && identity.facts.collected.kind === RECORDED_FACT_KIND);
  check("Recorded cash out is materials + overhead", identity.recorded.knownCashOut === 150);
  check("Wage labor is not recorded cash out", identity.recorded.knownCashOut === 150 && /not verified bank cash out/i.test(LABOR_WAGE_NOT_BANK_CASH_MESSAGE));
  check("Recorded margin is 75% on complete billed", identity.recorded.recordedDirectCost === 300 && identity.recorded.recordedGrossProfit === 900 && identity.recorded.recordedMarginPct === 75);
  check("Identity forecast matches recorded cash and margin", identity.forecast.projectedCashIn === 1000 && identity.forecast.projectedCashOut === 150 && identity.forecast.projectedMarginPct === 75);
  check("Forecast is labeled separately", identity.forecast.kind === FORECAST_KIND && identity.projections.cashIn.kind === FORECAST_KIND);
  check("Bank balance is unknown on both sides", identity.actualBankBalance === null && identity.projectedBankBalance === null && identity.projections.bankBalance.amount === null);
  check("Bank and accounting stay disconnected", identity.bankConnected === false && identity.accountingConnected === false);
  check("No tax conclusion field", identity.taxConclusion === null);
  check("Planner does not write records or prices", identity.writesRecords === false && identity.changesPrices === false);
  check("Unpaid stays out of identity cash in", identity.forecast.unpaidIncludedAsCashIn === false && identity.forecast.projectedUnpaidReceivable === 200);

  const varied = buildOwnerScenarioPlan(
    normal,
    parseOwnerScenarioAssumptions({ workload: "150", materials: "120", labor: "90", price: "110" }),
  );
  check("Workload 150% and price 110% scale billed", varied.forecast.projectedBilledRevenue === 1980);
  check("Collected cash scales with price and workload", varied.forecast.projectedCollectedCashIn === 1650 && varied.forecast.projectedCashIn === 1650);
  check("Existing unpaid does not scale with workload", varied.forecast.projectedUnpaidReceivable === 200);
  check("Labor 90% and workload 150% scale wage only", varied.forecast.projectedWageLabor === 270);
  check("Materials 120% and workload 150% scale job materials", varied.forecast.projectedJobMaterials === 180);
  check("Overhead is not scaled by workload", varied.forecast.projectedOverheadExpense === 50 && /Unallocated recorded expenses stay/i.test(OVERHEAD_NOT_SCALED_MESSAGE));
  check("Projected margin uses complete-job mix", varied.forecast.projectedDirectCost === 450 && varied.forecast.projectedGrossProfit === 1530 && varied.forecast.projectedMarginPct === 77.27);
  check("Projected cash out scales job materials only", varied.forecast.projectedCashOut === 230);
  check("Projected known net is forecast cash in minus cash out", varied.forecast.projectedKnownNet === 1420);

  const assumeUnpaid = buildOwnerScenarioPlan(normal, parseOwnerScenarioAssumptions({ assumeUnpaid: "1" }));
  check("Assumed collection is forecast-only", assumeUnpaid.forecast.unpaidIncludedAsCashIn === true && assumeUnpaid.forecast.kind === FORECAST_KIND);
  check("Assumed collection adds recorded unpaid to forecast cash in only", assumeUnpaid.forecast.projectedCashIn === 1200 && assumeUnpaid.recorded.knownCashIn === 1000);
  check("Assumed collection does not rewrite recorded unpaid", assumeUnpaid.recorded.unpaidReceivable === 200 && assumeUnpaid.forecast.projectedUnpaidReceivable === 0);

  console.log("\nSTATIC — Edge cases");
  const empty = buildOwnerScenarioPlan(plannerSource(), identityAssumptions());
  check("Zero jobs stay zero", empty.recorded.jobCount === 0 && empty.recorded.billedRevenue === 0 && empty.recorded.knownCashIn === 0);
  check("Zero jobs do not invent a margin", empty.recorded.recordedMarginPct === null && empty.forecast.projectedMarginPct === null);

  const incomplete = buildOwnerScenarioPlan(
    plannerSource({
      jobs: [{ id: "job-open", businessId: "biz-a", status: "IN_PROGRESS", createdAt: now, customerId: null, estimateId: null }],
      invoices: [
        {
          id: "inv-open",
          businessId: "biz-a",
          status: "SENT",
          total: 400,
          paidAt: null,
          createdAt: now,
          customerId: null,
          jobId: "job-open",
          paymentMethod: null,
          paymentReference: null,
        },
      ],
      approvedTimeEntries: [
        {
          id: "t-open",
          businessId: "biz-a",
          membershipId: "m1",
          jobId: "job-open",
          activityType: "JOB",
          startedAt: now,
          approvedHours: 2,
          approvedLaborCost: null,
        },
      ],
    }),
    identityAssumptions(),
  );
  check("Incomplete labor does not invent $0 cost", incomplete.recorded.recordedDirectCost === null && incomplete.forecast.projectedDirectCost === null);
  check("Incomplete labor keeps billed and unpaid as facts", incomplete.recorded.billedRevenue === 400 && incomplete.recorded.unpaidReceivable === 400 && incomplete.recorded.collectedRevenue === 0);
  check("Incomplete labor message is explicit", incomplete.recorded.incompleteLaborJobCount === 1 && /do not invent \$0 labor/i.test(INCOMPLETE_LABOR_MARGIN_MESSAGE));

  const zeroWorkload = buildOwnerScenarioPlan(normal, parseOwnerScenarioAssumptions({ workload: "0" }));
  check("Workload 0 projects no future volume", zeroWorkload.forecast.jobEquivalents === 0 && zeroWorkload.forecast.projectedBilledRevenue === 0);
  check("Workload 0 keeps existing unpaid as unpaid", zeroWorkload.forecast.projectedUnpaidReceivable === 200);
  check("Workload 0 keeps unallocated overhead in cash out", zeroWorkload.forecast.projectedCashOut === 50);

  const leaked = isolatePlannerSource(
    plannerSource({
      jobs: [
        { id: "job-1", businessId: "biz-a", status: "COMPLETED", createdAt: now, customerId: "c1", estimateId: null },
        { id: "job-b", businessId: "biz-b", status: "COMPLETED", createdAt: now, customerId: "c2", estimateId: null },
      ],
      invoices: [
        {
          id: "inv-a",
          businessId: "biz-a",
          status: "PAID",
          total: 10,
          paidAt: now,
          createdAt: now,
          customerId: "c1",
          jobId: "job-1",
          paymentMethod: null,
          paymentReference: null,
        },
        {
          id: "inv-b",
          businessId: "biz-b",
          status: "PAID",
          total: 9999,
          paidAt: now,
          createdAt: now,
          customerId: "c2",
          jobId: "job-b",
          paymentMethod: null,
          paymentReference: null,
        },
      ],
      payments: [
        {
          id: "pay-a",
          businessId: "biz-a",
          customerId: "c1",
          jobId: "job-1",
          invoiceId: "inv-a",
          purpose: "INVOICE_BALANCE",
          amount: 10,
          method: "CASH",
          receivedAt: now,
        },
        {
          id: "pay-b",
          businessId: "biz-b",
          customerId: "c2",
          jobId: "job-b",
          invoiceId: "inv-b",
          purpose: "INVOICE_BALANCE",
          amount: 9999,
          method: "CASH",
          receivedAt: now,
        },
      ],
      expenses: [
        {
          id: "e-a",
          businessId: "biz-a",
          occurredOn: now,
          description: "A",
          amount: 1,
          category: "OTHER",
          vendor: null,
          jobId: "job-1",
          recurring: false,
        },
        {
          id: "e-b",
          businessId: "biz-b",
          occurredOn: now,
          description: "B",
          amount: 8888,
          category: "OTHER",
          vendor: null,
          jobId: "job-b",
          recurring: false,
        },
      ],
    }),
  );
  check("Isolation drops foreign jobs", leaked.jobs.length === 1 && leaked.jobs[0]?.id === "job-1");
  check("Isolation drops foreign invoices", isolateSameBusinessInvoices(leaked.invoices, "biz-a").every((row) => row.businessId === "biz-a") && leaked.invoices.length === 1);
  check("Isolation drops foreign payments", isolateSameBusinessPayments(leaked.payments, "biz-a").length === 1);
  check("Isolation drops foreign expenses", isolateSameBusinessExpenses(leaked.expenses, "biz-a").length === 1);
  const isolatedPlan = buildOwnerScenarioPlan(
    plannerSource({
      businessId: "biz-a",
      invoices: [
        {
          id: "inv-a",
          businessId: "biz-a",
          status: "PAID",
          total: 10,
          paidAt: now,
          createdAt: now,
          customerId: null,
          jobId: null,
          paymentMethod: null,
          paymentReference: null,
        },
        {
          id: "inv-b",
          businessId: "biz-b",
          status: "PAID",
          total: 9999,
          paidAt: now,
          createdAt: now,
          customerId: null,
          jobId: null,
          paymentMethod: null,
          paymentReference: null,
        },
      ],
      payments: [
        {
          id: "pay-a",
          businessId: "biz-a",
          customerId: null,
          jobId: null,
          invoiceId: "inv-a",
          purpose: "INVOICE_BALANCE",
          amount: 10,
          method: "CASH",
          receivedAt: now,
        },
        {
          id: "pay-b",
          businessId: "biz-b",
          customerId: null,
          jobId: null,
          invoiceId: "inv-b",
          purpose: "INVOICE_BALANCE",
          amount: 9999,
          method: "CASH",
          receivedAt: now,
        },
      ],
    }),
    identityAssumptions(),
  );
  check("Cross-tenant invoices cannot inflate collected cash", isolatedPlan.recorded.collectedRevenue === 10 && isolatedPlan.recorded.billedRevenue === 10);

  const first = buildOwnerScenarioPlan(normal, parseOwnerScenarioAssumptions({ workload: "125", price: "105" }));
  const second = buildOwnerScenarioPlan(normal, parseOwnerScenarioAssumptions({ workload: "125", price: "105" }));
  check(
    "Same inputs are deterministic",
    first.forecast.projectedCashIn === second.forecast.projectedCashIn &&
      first.forecast.projectedMarginPct === second.forecast.projectedMarginPct &&
      first.forecast.projectedCashOut === second.forecast.projectedCashOut,
  );

  const savedBusy = toSavedOwnerScenarioAssumptionSet({
    id: "set-busy",
    businessId: "biz-a",
    name: "Busy summer",
    workloadPercent: 150,
    materialCostPercent: 120,
    laborCostPercent: 90,
    pricePercent: 110,
    assumeUnpaidInvoicesCollect: false,
  });
  const savedQuiet = toSavedOwnerScenarioAssumptionSet({
    id: "set-quiet",
    businessId: "biz-a",
    name: "Quiet winter",
    workloadPercent: 80,
    materialCostPercent: 100,
    laborCostPercent: 100,
    pricePercent: 100,
    assumeUnpaidInvoicesCollect: false,
  });
  const savedForeign = toSavedOwnerScenarioAssumptionSet({
    id: "set-foreign",
    businessId: "biz-b",
    name: "Other tenant",
    workloadPercent: 200,
    materialCostPercent: 200,
    laborCostPercent: 200,
    pricePercent: 200,
    assumeUnpaidInvoicesCollect: true,
  });
  check("Saved set kind is not a recorded fact", savedBusy.kind === ASSUMPTION_SET_KIND && savedBusy.kind !== RECORDED_FACT_KIND && savedBusy.kind !== FORECAST_KIND);
  check("Reopened knobs match the saved percents", assumptionsFromSavedSet(savedBusy).workloadPercent === 150 && assumptionsFromSavedSet(savedBusy).pricePercent === 110);
  const compared = buildOwnerScenarioComparison(normal, savedBusy, savedQuiet);
  check("Compare uses the same recorded facts", compared?.sameRecordedFacts === true && compared.recorded.collectedRevenue === identity.recorded.collectedRevenue && compared.recorded.knownCashOut === identity.recorded.knownCashOut);
  check("Compare left forecast matches the busy overlay", compared?.left.forecast.projectedBilledRevenue === varied.forecast.projectedBilledRevenue);
  check("Compare right forecast is not the busy overlay", compared?.right.forecast.projectedBilledRevenue !== compared?.left.forecast.projectedBilledRevenue);
  check("Compare deltas are forecast-only", compared?.deltas.kind === FORECAST_KIND && compared.deltas.message === FORECAST_DELTA_MESSAGE);
  check("Compare billed delta is right minus left", compared?.deltas.billed === compared.right.forecast.projectedBilledRevenue - compared.left.forecast.projectedBilledRevenue);
  check("Compare does not invent a bank balance", compared?.actualBankBalance === null && compared?.projectedBankBalance === null);
  check("Compare does not write records or prices", compared?.writesRecords === false && compared?.changesPrices === false);
  check("Foreign assumption set cannot enter a comparison", buildOwnerScenarioComparison(normal, savedBusy, savedForeign) === null);
  check("Isolation drops foreign saved sets", isolateSameBusinessAssumptionSets([savedBusy, savedForeign], "biz-a").every((row) => row.businessId === "biz-a"));

  console.log("\nROLE — OWNER only");
  check("OWNER can access the planner", canAccessOwnerScenarioPlanner("OWNER") === true);
  check("ADMIN cannot access the planner", canAccessOwnerScenarioPlanner("ADMIN") === false);
  check("MEMBER cannot access the planner", canAccessOwnerScenarioPlanner("MEMBER") === false);
  check("MEMBER has no VIEW_REPORTS", !roleHasCapability("MEMBER", CAPABILITIES.VIEW_REPORTS));
  check("MEMBER cannot access the management console", !canAccessManagementConsole("MEMBER"));

  let adminBlocked = false;
  try {
    assertCanReadOwnerScenarioPlanner(makeAccess("biz-a", "ADMIN", "mem-admin"));
  } catch (error) {
    adminBlocked = error instanceof ForbiddenError;
  }
  check("ADMIN read fails closed", adminBlocked);

  let memberBlocked = false;
  try {
    assertCanReadOwnerScenarioPlanner(makeAccess("biz-a", "MEMBER", "mem-member"));
  } catch (error) {
    memberBlocked = error instanceof ForbiddenError;
  }
  check("MEMBER read fails closed", memberBlocked);

  let ownerAllowed = true;
  try {
    assertCanReadOwnerScenarioPlanner(makeAccess("biz-a", "OWNER", "mem-owner"));
  } catch {
    ownerAllowed = false;
  }
  check("OWNER read is allowed", ownerAllowed);

  let adminWriteBlocked = false;
  try {
    assertCanWriteOwnerScenarioPlanner(makeAccess("biz-a", "ADMIN", "mem-admin"));
  } catch (error) {
    adminWriteBlocked = error instanceof ForbiddenError;
  }
  check("ADMIN write fails closed", adminWriteBlocked);

  let memberWriteBlocked = false;
  try {
    assertCanWriteOwnerScenarioPlanner(makeAccess("biz-a", "MEMBER", "mem-member"));
  } catch (error) {
    memberWriteBlocked = error instanceof ForbiddenError;
  }
  check("MEMBER write fails closed", memberWriteBlocked);

  let ownerWriteAllowed = true;
  try {
    assertCanWriteOwnerScenarioPlanner(makeAccess("biz-a", "OWNER", "mem-owner"));
  } catch {
    ownerWriteAllowed = false;
  }
  check("OWNER write is allowed", ownerWriteAllowed);

  console.log("\nDB — Tenant isolation, authorization, and bounded reads");
  const businessA = await prisma.business.create({
    data: { name: "Alpha Planner", slug: `alpha-plan-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Planner", slug: `beta-plan-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Ada Owner", email: `ada-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ivy Admin", email: `ivy-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `mia-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `bea-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });
  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Planner" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Customer" },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "COMPLETED",
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
      jobId: jobA.id,
      status: "SENT",
      total: new Prisma.Decimal(200),
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
  const invoiceB = await prisma.invoice.create({
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
      businessId: businessB.id,
      customerId: customerB.id,
      jobId: jobB.id,
      invoiceId: invoiceB.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(8888),
      method: "CASH",
      receivedAt: now,
    },
  });
  await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: ownerMem.id,
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
  await prisma.expense.create({
    data: {
      businessId: businessA.id,
      occurredOn: now,
      description: "Lumber",
      amount: new Prisma.Decimal(100),
      category: "MATERIALS",
      vendor: "Depot",
      jobId: jobA.id,
    },
  });
  await prisma.expense.create({
    data: {
      businessId: businessA.id,
      occurredOn: now,
      description: "Voided paint",
      amount: new Prisma.Decimal(400),
      category: "MATERIALS",
      vendor: "Depot",
      jobId: jobA.id,
      voidedAt: now,
    },
  });
  await prisma.expense.create({
    data: {
      businessId: businessA.id,
      occurredOn: now,
      description: "Insurance",
      amount: new Prisma.Decimal(50),
      category: "INSURANCE",
      vendor: "Insurer",
    },
  });
  await prisma.expense.create({
    data: {
      businessId: businessB.id,
      occurredOn: now,
      description: "Beta materials",
      amount: new Prisma.Decimal(7777),
      category: "MATERIALS",
      vendor: "Other",
      jobId: jobB.id,
    },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  const planA = await loadOwnerScenarioPlan(prisma, ownerA, identityAssumptions());
  check("Owner A billed ignores tenant B", planA.recorded.billedRevenue === 1200);
  check("Owner A collected ignores tenant B", planA.recorded.collectedRevenue === 1000);
  check("Owner A unpaid is the SENT invoice only", planA.recorded.unpaidReceivable === 200);
  check("Voided expense is not cash out", planA.recorded.knownCashOut === 150 && planA.recorded.jobMaterialsExpense === 100);
  check("Owner A margin uses recorded labor and materials", planA.recorded.recordedMarginPct === 75);
  check("Owner A bank balance stays null", planA.actualBankBalance === null && planA.projectedBankBalance === null);
  check("Loader businessId comes from access, not a browser field", planA.businessId === businessA.id);

  const planB = await loadOwnerScenarioPlan(prisma, ownerB, identityAssumptions());
  check("Owner B cannot see tenant A collected cash", planB.recorded.collectedRevenue === 8888);
  check("Owner B cannot see tenant A materials", planB.recorded.jobMaterialsExpense === 7777);
  check("Owner B unpaid is not tenant A's SENT invoice", planB.recorded.unpaidReceivable === 0);

  let adminLoadBlocked = false;
  try {
    await loadOwnerScenarioPlan(prisma, adminA, identityAssumptions());
  } catch (error) {
    adminLoadBlocked = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  check("ADMIN loader cannot read the planner", adminLoadBlocked);

  let memberLoadBlocked = false;
  try {
    await loadOwnerScenarioPlan(prisma, memberA, identityAssumptions());
  } catch (error) {
    memberLoadBlocked = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  check("MEMBER loader cannot read the planner", memberLoadBlocked);

  const beforeCount = await prisma.invoice.count({ where: { businessId: businessA.id } });
  await prisma.invoice.createMany({
    data: Array.from({ length: PLANNER_READ_BOUND }, (_, index) => ({
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: jobA.id,
      status: "SENT",
      total: new Prisma.Decimal(1),
    })),
  });
  const loaded = await loadOwnerScenarioPlannerSource(prisma, ownerA);
  check("Bounded invoice read stops at the planner bound", loaded.source.invoices.length === PLANNER_READ_BOUND);
  check("Hitting the bound flags truncation", loaded.readsTruncated === true);
  const truncatedPlan = await loadOwnerScenarioPlan(prisma, ownerA, identityAssumptions());
  check("Truncated plan keeps the bound message", truncatedPlan.readsTruncated === true && truncatedPlan.messages.bound === READ_BOUND_MESSAGE);
  const afterCount = await prisma.invoice.count({ where: { businessId: businessA.id } });
  check("Bounded read does not change stored invoice count", afterCount === beforeCount + PLANNER_READ_BOUND);

  console.log("\nDB — Save, name, reopen, and compare against the same facts");
  const invoicesBeforeSave = await prisma.invoice.count({ where: { businessId: businessA.id } });
  const paymentsBeforeSave = await prisma.payment.count({ where: { businessId: businessA.id } });
  const expensesBeforeSave = await prisma.expense.count({ where: { businessId: businessA.id } });
  const jobsBeforeSave = await prisma.job.count({ where: { businessId: businessA.id } });

  const storedBusy = await saveOwnerScenarioAssumptionSet(prisma, ownerA, {
    name: "Busy summer",
    workload: "150",
    materials: "120",
    labor: "90",
    price: "110",
  });
  check("OWNER can save a named assumption set", storedBusy.created === true && storedBusy.set.name === "Busy summer" && storedBusy.set.kind === ASSUMPTION_SET_KIND);
  check("Saved set keeps knobs, not forecasts", storedBusy.set.workloadPercent === 150 && storedBusy.set.pricePercent === 110 && !("projectedCashIn" in storedBusy.set));
  check("Save reports that books were not written", storedBusy.message === SAVE_DOES_NOT_WRITE_BOOKS_MESSAGE);

  const reopened = await loadOwnerScenarioAssumptionSet(prisma, ownerA, storedBusy.set.id);
  check("OWNER can reopen the named set", reopened?.id === storedBusy.set.id && reopened?.workloadPercent === 150);

  const workspaceReopen = await loadOwnerScenarioPlannerWorkspace(prisma, ownerA, { set: storedBusy.set.id });
  const currentFacts = await loadOwnerScenarioPlan(prisma, ownerA, identityAssumptions());
  check("Reopened workspace uses saved knobs on current facts", workspaceReopen.openedSet?.id === storedBusy.set.id && workspaceReopen.plan.assumptions.workloadPercent === 150 && workspaceReopen.plan.recorded.collectedRevenue === currentFacts.recorded.collectedRevenue && workspaceReopen.plan.recorded.kind === RECORDED_FACT_KIND);
  check("Reopened forecast is labeled separately from recorded facts", workspaceReopen.plan.forecast.kind === FORECAST_KIND && workspaceReopen.plan.recorded.kind === RECORDED_FACT_KIND);

  const renamed = await saveOwnerScenarioAssumptionSet(prisma, ownerA, {
    name: "Busy summer",
    workload: "160",
    materials: "120",
    labor: "90",
    price: "110",
  });
  check("Saving the same name updates knobs in place", renamed.created === false && renamed.set.id === storedBusy.set.id && renamed.set.workloadPercent === 160);

  const storedQuiet = await saveOwnerScenarioAssumptionSet(prisma, ownerA, {
    name: "Quiet winter",
    workload: "80",
    materials: "100",
    labor: "100",
    price: "100",
  });
  const workspaceCompare = await loadOwnerScenarioPlannerWorkspace(prisma, ownerA, {
    left: storedBusy.set.id,
    right: storedQuiet.set.id,
  });
  check("Compare loads two named sets", workspaceCompare.comparison?.left.set.name === "Busy summer" && workspaceCompare.comparison?.right.set.name === "Quiet winter");
  check("Compare recorded facts match the live recorded sample", workspaceCompare.comparison?.recorded.collectedRevenue === workspaceCompare.plan.recorded.collectedRevenue && workspaceCompare.comparison?.recorded.knownCashOut === workspaceCompare.plan.recorded.knownCashOut);
  check("Compare forecasts differ while facts stay shared", workspaceCompare.comparison?.left.forecast.projectedBilledRevenue !== workspaceCompare.comparison?.right.forecast.projectedBilledRevenue && workspaceCompare.comparison?.sameRecordedFacts === true);
  check("Compare deltas stay forecast-kind", workspaceCompare.comparison?.deltas.kind === FORECAST_KIND && workspaceCompare.comparison?.left.forecast.kind === FORECAST_KIND);

  const listedA = await listOwnerScenarioAssumptionSets(prisma, ownerA);
  check("Owner A lists only same-business named sets", listedA.sets.length === 2 && listedA.sets.every((row) => row.businessId === businessA.id));

  const storedBeta = await saveOwnerScenarioAssumptionSet(prisma, ownerB, {
    name: "Busy summer",
    workload: "200",
    materials: "200",
    labor: "200",
    price: "200",
    assumeUnpaid: "1",
  });
  const listedB = await listOwnerScenarioAssumptionSets(prisma, ownerB);
  check("Owner B cannot list tenant A assumption sets", listedB.sets.length === 1 && listedB.sets[0]?.id === storedBeta.set.id);
  const leakedReopen = await loadOwnerScenarioAssumptionSet(prisma, ownerA, storedBeta.set.id);
  check("Owner A cannot reopen tenant B assumption set", leakedReopen === null);
  const leakedCompare = await loadOwnerScenarioPlannerWorkspace(prisma, ownerA, {
    left: storedBusy.set.id,
    right: storedBeta.set.id,
  });
  check("Owner A cannot compare against tenant B", leakedCompare.comparison === null && leakedCompare.comparisonError === ASSUMPTION_SET_NOT_FOUND_MESSAGE);

  let adminSaveBlocked = false;
  try {
    await saveOwnerScenarioAssumptionSet(prisma, adminA, { name: "Admin set", workload: "110" });
  } catch (error) {
    adminSaveBlocked = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  check("ADMIN cannot save an assumption set", adminSaveBlocked);

  let memberSaveBlocked = false;
  try {
    await saveOwnerScenarioAssumptionSet(prisma, memberA, { name: "Member set", workload: "110" });
  } catch (error) {
    memberSaveBlocked = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  check("MEMBER cannot save an assumption set", memberSaveBlocked);

  let invalidSaveBlocked = false;
  try {
    await saveOwnerScenarioAssumptionSet(prisma, ownerA, { name: "Broken", workload: "999" });
  } catch (error) {
    invalidSaveBlocked = error instanceof OwnerScenarioAssumptionSetError && error.message === FIX_ASSUMPTIONS_BEFORE_SAVE_MESSAGE;
  }
  check("Invalid knobs cannot be saved", invalidSaveBlocked);

  let unnamedSaveBlocked = false;
  try {
    await saveOwnerScenarioAssumptionSet(prisma, ownerA, { name: "   " });
  } catch (error) {
    unnamedSaveBlocked = error instanceof OwnerScenarioAssumptionSetError && error.message === NAME_REQUIRED_MESSAGE;
  }
  check("Unnamed assumption set cannot be saved", unnamedSaveBlocked);

  check(
    "Save did not write invoices, payments, expenses, or jobs",
    (await prisma.invoice.count({ where: { businessId: businessA.id } })) === invoicesBeforeSave &&
      (await prisma.payment.count({ where: { businessId: businessA.id } })) === paymentsBeforeSave &&
      (await prisma.expense.count({ where: { businessId: businessA.id } })) === expensesBeforeSave &&
      (await prisma.job.count({ where: { businessId: businessA.id } })) === jobsBeforeSave,
  );

  await prisma.ownerScenarioAssumptionSet.createMany({
    data: Array.from({ length: PLANNER_SET_READ_BOUND }, (_, index) => ({
      businessId: businessA.id,
      name: `Bound set ${index + 1}`,
      workloadPercent: new Prisma.Decimal(100),
      materialCostPercent: new Prisma.Decimal(100),
      laborCostPercent: new Prisma.Decimal(100),
      pricePercent: new Prisma.Decimal(100),
    })),
  });
  const boundedSets = await listOwnerScenarioAssumptionSets(prisma, ownerA);
  check("Bounded assumption-set read stops at the planner set bound", boundedSets.sets.length === PLANNER_SET_READ_BOUND);
  check("Hitting the set bound flags truncation", boundedSets.truncated === true);
  const storedSetCount = await prisma.ownerScenarioAssumptionSet.count({ where: { businessId: businessA.id } });
  check("Bounded set read does not change stored set count", storedSetCount === PLANNER_SET_READ_BOUND + 2);
  check("Set bound message is explicit", /bounded sample/.test(SET_READ_BOUND_MESSAGE));

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — owner scenario planner checks`);
  process.exit(failures === 0 ? 0 : 1);
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}

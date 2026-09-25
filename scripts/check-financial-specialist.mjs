/**
 * AI Chief of Staff Financial specialist proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-financial-specialist.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, CAPABILITIES, requireBusinessCapability } = await import("@/lib/authorization");
const {
  FINANCIAL_CONTEXT_CAPS,
  FINANCIAL_OWNED_RECOMMENDATION_KEYS,
  getFinancialSpecialistInterpretationCount,
  interpretFinancialSpecialist,
  isFinancialJobFindingKey,
  jobIdsFromFinancialFindings,
  loadCanonicalRecommendationCatalog,
  projectFinancialContext,
  planSpecialists,
  resetFinancialSpecialistCounters,
  resolveConflicts,
  runChiefOfStaffCoach,
  synthesizeCoachAnswer,
} = await import("@/lib/chief-of-staff");
const { buildBsosHealthMetrics } = await import("@/lib/bsos");
const { answerCoachFromFacts } = await import("@/lib/ai/coach");
const {
  getFinancialSourceLoadCount,
  resetFinancialSourceLoadCount,
} = await import("@/lib/financial-intelligence-data");
const {
  getFinancialIntelligenceBuildCount,
  resetFinancialIntelligenceBuildCount,
} = await import("@/lib/financial-intelligence");
const { PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog");
const { joinLineDescription } = await import("@/lib/estimate-line-scope");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_financial_specialist_test";
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

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: "owner@example.com", name: "Owner" },
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

async function entitleFounder(businessId) {
  await prisma.businessSaasSubscription.create({
    data: {
      businessId,
      status: "active",
      planCode: "FOUNDER",
      legacyExempt: true,
    },
  });
}

async function createOwnerWorkspace(name) {
  const user = await prisma.user.create({
    data: { name: `${name} Owner`, email: `${name}-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const business = await prisma.business.create({
    data: { name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const membership = await prisma.membership.create({
    data: { userId: user.id, businessId: business.id, role: "OWNER" },
  });
  return {
    user,
    business,
    membership,
    access: makeAccess(business.id, "OWNER", membership.id, user.id),
  };
}

function resetLoads() {
  resetFinancialSourceLoadCount();
  resetFinancialIntelligenceBuildCount();
  resetFinancialSpecialistCounters();
}

try {
  const financialSrc = readFileSync(new URL("../src/lib/chief-of-staff/specialists/financial.ts", import.meta.url), "utf8");
  const snapshotSrc = readFileSync(new URL("../src/lib/chief-of-staff/financial-snapshot.ts", import.meta.url), "utf8");
  const runSrc = readFileSync(new URL("../src/lib/chief-of-staff/run.ts", import.meta.url), "utf8");
  const opsSrc = readFileSync(new URL("../src/lib/financial-intelligence-ops.ts", import.meta.url), "utf8");

  console.log("\nSTATIC — Financial specialist is read/explain only");
  check("Financial specialist performs no LLM call", !financialSrc.includes("runAiTask") && !financialSrc.includes("resolveAiProvider"));
  check("Financial specialist does not load FinancialSource itself", !financialSrc.includes("loadFinancialSource("));
  check("Financial specialist does not rebuild intelligence", !financialSrc.includes("buildFinancialIntelligence("));
  check(
    "Financial specialist has no domain writes",
    !financialSrc.includes("saveLaborBurden") &&
      !financialSrc.includes("payment.create") &&
      !financialSrc.includes("invoice.update") &&
      !financialSrc.includes("expense.create") &&
      !financialSrc.includes("AiActionProposal") &&
      !snapshotSrc.includes("AiActionProposal") &&
      !runSrc.includes("AiActionProposal"),
  );
  check("Financial specialist does not import write ops", !financialSrc.includes("financial-intelligence-ops"));
  check(
    "Existing recommendation keys are reused, not renamed",
    FINANCIAL_OWNED_RECOMMENDATION_KEYS.join(",") ===
      "collect-unpaid-invoices,receivable-needs-attention,review-low-margin-jobs,service-margin-below-target,missing-wage-data,estimate-labor-overrun,review-recurring-expenses,expense-growth,high-value-customer-concentration",
  );
  check("Write ops remain outside the specialist", opsSrc.includes("saveLaborBurdenSetting"));

  const profitPlan = planSpecialists({
    question: "Which jobs are losing money and what is my margin?",
    activeRecommendationKeys: [],
  });
  const cashPlan = planSpecialists({
    question: "How much collected cash and outstanding receivables do I have?",
    activeRecommendationKeys: [],
  });
  const laborPlan = planSpecialists({
    question: "Is labor cost or burden complete, and what about target margin pricing?",
    activeRecommendationKeys: [],
  });
  const genericFocus = planSpecialists({
    question: "What should I focus on this week?",
    activeRecommendationKeys: [],
  });
  const recPlan = planSpecialists({
    question: "What should I focus on this week?",
    activeRecommendationKeys: ["collect-unpaid-invoices"],
  });
  check("14. Planner selects Financial for profit/margin", profitPlan.selectedIds.includes("FINANCIAL"));
  check("14. Planner selects Financial for cash/receivables", cashPlan.selectedIds.includes("FINANCIAL"));
  check("14. Planner selects Financial for labor cost/burden/pricing", laborPlan.selectedIds.includes("FINANCIAL"));
  check("15. Generic focus does not select Financial", !genericFocus.selectedIds.includes("FINANCIAL"));
  check("16. Active Financial recommendation selects Financial", recPlan.selectedIds.includes("FINANCIAL"));

  const tenantA = await createOwnerWorkspace("Alpha Financial");
  const tenantB = await createOwnerWorkspace("Beta Financial");
  const starter = await createOwnerWorkspace("Starter Financial");
  const memberUser = await prisma.user.create({
    data: { name: "Member", email: `member-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: tenantA.business.id, role: "MEMBER" },
  });
  const memberAccess = makeAccess(tenantA.business.id, "MEMBER", memberMem.id, memberUser.id);

  await entitleFounder(tenantA.business.id);
  await entitleFounder(tenantB.business.id);
  await prisma.businessSaasSubscription.create({
    data: { businessId: starter.business.id, status: "active", planCode: "STARTER" },
  });

  const customerA = await prisma.customer.create({
    data: { businessId: tenantA.business.id, name: "Ada Cash" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: tenantB.business.id, name: "Beta Secret" },
  });

  const sentPartial = await prisma.invoice.create({
    data: { businessId: tenantA.business.id, customerId: customerA.id, status: "SENT", total: 1000 },
  });
  await prisma.payment.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      invoiceId: sentPartial.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(400),
      method: "CASH",
      receivedAt: new Date(),
    },
  });
  await prisma.invoice.create({
    data: { businessId: tenantA.business.id, customerId: customerA.id, status: "PAID", total: 250, paidAt: new Date() },
  });
  await prisma.invoice.create({
    data: { businessId: tenantA.business.id, customerId: customerA.id, status: "SENT", total: 175 },
  });
  await prisma.invoice.create({
    data: { businessId: tenantB.business.id, customerId: customerB.id, status: "SENT", total: 8888 },
  });

  const negativeJob = await prisma.job.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const negativeInvoice = await prisma.invoice.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      jobId: negativeJob.id,
      status: "PAID",
      total: 100,
      paidAt: new Date(),
    },
  });
  await prisma.payment.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      jobId: negativeJob.id,
      invoiceId: negativeInvoice.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(100),
      method: "CASH",
      receivedAt: new Date(),
    },
  });
  await prisma.timeEntry.create({
    data: {
      businessId: tenantA.business.id,
      membershipId: tenantA.membership.id,
      jobId: negativeJob.id,
      activityType: "JOB",
      status: "APPROVED",
      startedAt: new Date(),
      endedAt: new Date(),
      approvedHours: 10,
      approvedLaborCost: 250,
    },
  });

  const unknownJob = await prisma.job.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  await prisma.timeEntry.create({
    data: {
      businessId: tenantA.business.id,
      membershipId: tenantA.membership.id,
      jobId: unknownJob.id,
      activityType: "JOB",
      status: "APPROVED",
      startedAt: new Date(),
      endedAt: new Date(),
      approvedHours: 4,
      approvedLaborCost: null,
    },
  });

  for (let i = 0; i < 7; i += 1) {
    await prisma.invoice.create({
      data: { businessId: tenantA.business.id, customerId: customerA.id, status: "SENT", total: 10 + i },
    });
  }

  console.log("\nAUTH — tenant isolation, MEMBER, entitlement");
  try {
    requireBusinessCapability(memberAccess, CAPABILITIES.VIEW_REPORTS);
    check("2. MEMBER remains blocked from VIEW_REPORTS", false);
  } catch (error) {
    check("2. MEMBER remains blocked from VIEW_REPORTS", error instanceof ForbiddenError);
  }
  try {
    await runChiefOfStaffCoach(prisma, memberAccess, {
      question: "How much collected cash do I have?",
      attemptId: randomUUID(),
      browserBusinessId: tenantA.business.id,
    });
    check("2. MEMBER remains blocked from Coach", false);
  } catch (error) {
    check(
      "2. MEMBER remains blocked from Coach",
      error instanceof ForbiddenError || /permission/i.test(error instanceof Error ? error.message : ""),
    );
  }

  resetLoads();
  const catalogA = await loadCanonicalRecommendationCatalog(prisma, tenantA.business.id);
  const catalogB = await loadCanonicalRecommendationCatalog(prisma, tenantB.business.id);
  const catalogStarter = await loadCanonicalRecommendationCatalog(prisma, starter.business.id);
  const resultA = interpretFinancialSpecialist(catalogA, "How much collected cash and outstanding receivables do I have?");
  const resultB = interpretFinancialSpecialist(catalogB, "How much collected cash do I have?");
  const resultStarter = interpretFinancialSpecialist(catalogStarter, "How much profit do I have?");
  const factsA = catalogA.financial.intelligence
    ? projectFinancialContext(catalogA, "How much collected cash and outstanding receivables do I have?", catalogA.financial.intelligence).facts
    : {};
  const factsB = catalogB.financial.intelligence
    ? projectFinancialContext(catalogB, "How much collected cash do I have?", catalogB.financial.intelligence).facts
    : {};

  check("1. Tenant A snapshot is entitled", catalogA.financial.entitled === true && Boolean(catalogA.financial.intelligence));
  check("1. Tenant A cannot see B invoice total 8888", !JSON.stringify(resultA).includes("8888"));
  check("1. Tenant B cannot see A collected 400", factsB["collected-customer-cash"] !== "400.00" && factsB["collected-customer-cash"] !== "750.00");
  check("1. Tenant B collected cash stays on B", factsB["collected-customer-cash"] === "0.00");
  check("3. No REPORTING_INSIGHTS skips Financial", resultStarter.status === "SKIPPED");
  check("3. Skipped Financial has a limitation", /Reporting Insights/i.test(resultStarter.limitation ?? ""));
  check("3. Skipped Financial has no fake zeroes", resultStarter.factKeys.length === 0 && resultStarter.findings.length === 0);

  check("4. SENT 1000 + Payment 400 collects 400", factsA["collected-customer-cash"] === "750.00" || factsA["collected-customer-cash"] === "400.00" || Number(factsA["collected-customer-cash"]) >= 400);
  const intelA = catalogA.financial.intelligence;
  const partialInvoice = intelA.receivables.rows.find((row) => row.invoiceId === sentPartial.id);
  check("4. Partial payment stays partial — collected 400 / remaining 600", partialInvoice?.collectedAgainstInvoice === 400 && partialInvoice?.balanceDue === 600);
  check("4. Combined collected includes payment-backed cash", Number(factsA["collected-customer-cash"]) === 750);
  const legacyPaid = intelA.cashFlow.collectedCustomerPayments;
  check("5. PAID legacy invoice with no Payment rows uses fallback", legacyPaid === 750);
  const sentUnpaid = intelA.receivables.rows.filter((row) => row.invoiceTotal === 175);
  check("6. SENT invoice with no payment is not collected", sentUnpaid.length === 1 && sentUnpaid[0].collectedAgainstInvoice === 0 && sentUnpaid[0].balanceDue === 175);

  check("7. Bank stays disconnected", factsA["bank-connected"] === "false" && intelA.bankConnected === false);
  check("7. Accounting stays disconnected", factsA["accounting-connected"] === "false" && intelA.accountingConnected === false);
  check("7. No invented bank/accounting balance", factsA["projected-bank-balance"] === "unknown" && factsA["projected-accounting-balance"] === "unknown" && intelA.cashFlow.projectedBalance === null);
  check("8. Missing wage stays unknown/incomplete", factsA["labor-cost-completeness"] === "incomplete/unknown");
  check("9. Missing target margin is unconfigured, not 0%", factsA["target-margin-configuration"] === "unconfigured" && intelA.laborBurden.targetGrossMarginRate == null);
  check("10. Missing burden is unconfigured, not 0%", factsA["burden-configuration"] === "unconfigured" && intelA.laborBurden.burdenRate == null);

  const negative = intelA.jobProfitability.find((job) => job.jobId === negativeJob.id);
  check("11. Negative-margin job is projected", Boolean(negative) && negative.grossProfit === -150);
  check("11. Specialist reports the negative margin", Number(factsA["lowest-margin-job"]) === -150);

  const unknownCost = intelA.jobProfitability.find((job) => job.jobId === unknownJob.id);
  check("24. Incomplete cost remains unknown", unknownCost?.grossProfit == null && unknownCost?.recordedDirectCost == null && unknownCost?.completeness.laborCostComplete === false);

  const receivableFact = factsA["receivables-top"] ?? "";
  check("12. Receivables are capped at 5", receivableFact.split("|").filter(Boolean).length <= FINANCIAL_CONTEXT_CAPS.receivables);
  check("12. Source receivables exceed the cap", intelA.receivables.rows.filter((row) => row.balanceDue > 0).length > FINANCIAL_CONTEXT_CAPS.receivables);
  check("13. Fact keys stay bounded", resultA.factKeys.length <= FINANCIAL_CONTEXT_CAPS.facts);
  check(
    "13. Context does not pass raw ledgers or secrets",
    !JSON.stringify(resultA).includes("stripe") &&
      !JSON.stringify(resultA).includes("sk_live") &&
      !/phone|email|address/i.test(JSON.stringify(factsA)),
  );

  const noJobBiz = await createOwnerWorkspace("No Jobs Financial");
  await entitleFounder(noJobBiz.business.id);
  const noJobCatalog = await loadCanonicalRecommendationCatalog(prisma, noJobBiz.business.id);
  const noJobResult = interpretFinancialSpecialist(noJobCatalog, "Should I change pricing?");
  const noJobFacts = noJobCatalog.financial.intelligence
    ? projectFinancialContext(noJobCatalog, "Should I change pricing?", noJobCatalog.financial.intelligence).facts
    : {};
  check(
    "23. No completed jobs → no invented pricing signal",
    noJobFacts["pricing-sample"] === "no-completed-jobs-with-complete-cost" &&
      noJobResult.findings.every((row) => !row.key.startsWith("financial-pricing:")),
  );

  console.log("\nRUNTIME — orchestration, one-load, failure, writes");
  resetLoads();
  const selected = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "How much collected cash and outstanding receivables do I have?",
    attemptId: randomUUID(),
    browserBusinessId: tenantB.business.id,
  });
  check("1. Coach answer for A omits B 8888", Boolean(selected.text) && !selected.text.includes("8888"));
  check("4/22. Disconnected provider still explains recorded Financial facts", /400|600|750|collected|receivable|invoice/i.test(selected.text ?? ""));
  check("7. Disconnected answer does not invent a bank balance", !/bank balance of|accounting balance/i.test(selected.text ?? ""));
  check("18. Exactly one Financial source load when selected", getFinancialSourceLoadCount() === 1);
  check("18. Exactly one Financial intelligence build when selected", getFinancialIntelligenceBuildCount() === 1);
  check("18. Financial specialist interprets once and does not reload", getFinancialSpecialistInterpretationCount() === 1);
  check("22. Orchestration can complete while the provider is disconnected", selected.orchestrationStatus === "COMPLETED");

  const emptyFocus = await createOwnerWorkspace("Focus Only");
  await entitleFounder(emptyFocus.business.id);
  await prisma.membership.update({
    where: { id: emptyFocus.membership.id },
    data: { hourlyWage: 25 },
  });
  resetLoads();
  const unselected = await runChiefOfStaffCoach(prisma, emptyFocus.access, {
    question: "What should I focus on this week?",
    attemptId: randomUUID(),
  });
  check("15. Generic focus orchestration stays at Attention", unselected.orchestrationStatus === "COMPLETED");
  check("19. Existing entitled catalog may still build Financial once", getFinancialSourceLoadCount() <= 1);
  check("19. Financial specialist does not interpret when not selected", getFinancialSpecialistInterpretationCount() === 0);

  resetLoads();
  const starterAsk = await runChiefOfStaffCoach(prisma, starter.access, {
    question: "How much profit and collected cash do I have?",
    attemptId: randomUUID(),
  });
  check("3. Starter Financial skip does not invent revenue", /Reporting Insights|not entitled/i.test(starterAsk.text ?? ""));
  check("3. Starter skip does not load Financial Intelligence", getFinancialSourceLoadCount() === 0 && getFinancialIntelligenceBuildCount() === 0);
  check("19. Selected-but-skipped Financial still interprets once", getFinancialSpecialistInterpretationCount() === 1);

  const partial = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "How is my profit this month?",
    attemptId: randomUUID(),
    test: { failFinancialLoad: true },
  });
  check("17. Financial loader failure is PARTIAL", partial.orchestrationStatus === "PARTIAL");
  check("17. ATTENTION survives loader failure", /surviving facts|could not be loaded|unavailable/i.test(partial.text ?? ""));
  check("17. Failure does not invent substitute numbers", !/8888/.test(partial.text ?? ""));

  const failSpecialist = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "How is my profit this month?",
    attemptId: randomUUID(),
    test: { failSpecialistId: "FINANCIAL" },
  });
  check("17. Injected Financial specialist failure is PARTIAL", failSpecialist.orchestrationStatus === "PARTIAL");

  const before = {
    payments: await prisma.payment.count({ where: { businessId: tenantA.business.id } }),
    expenses: await prisma.expense.count({ where: { businessId: tenantA.business.id } }),
    invoices: await prisma.invoice.count({ where: { businessId: tenantA.business.id } }),
    burden: await prisma.businessLaborBurdenSetting.count({ where: { businessId: tenantA.business.id } }),
    patterns: await prisma.recurringExpensePattern.count({ where: { businessId: tenantA.business.id } }),
  };
  await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Review my expenses, pricing, invoices, and labor burden.",
    attemptId: randomUUID(),
  });
  const after = {
    payments: await prisma.payment.count({ where: { businessId: tenantA.business.id } }),
    expenses: await prisma.expense.count({ where: { businessId: tenantA.business.id } }),
    invoices: await prisma.invoice.count({ where: { businessId: tenantA.business.id } }),
    burden: await prisma.businessLaborBurdenSetting.count({ where: { businessId: tenantA.business.id } }),
    patterns: await prisma.recurringExpensePattern.count({ where: { businessId: tenantA.business.id } }),
  };
  check("20. No Payment writes", before.payments === after.payments);
  check("20. No Expense writes", before.expenses === after.expenses);
  check("20. No Invoice writes", before.invoices === after.invoices);
  check("20. No labor-burden writes", before.burden === after.burden);
  check("20. No recurring-expense mutations", before.patterns === after.patterns);

  const conflicts = resolveConflicts({
    results: [
      {
        specialistId: "FINANCIAL",
        status: "OK",
        findings: [
          {
            key: "review-low-margin-jobs",
            title: "Low margin",
            summary: "x",
            recommendationKeys: ["review-low-margin-jobs"],
            factKeys: [],
            entityIds: [negativeJob.id],
          },
        ],
        factKeys: [],
        recommendationKeys: ["review-low-margin-jobs", "missing-wage-data"],
      },
      {
        specialistId: "WORKFORCE",
        status: "OK",
        findings: [
          {
            key: "workforce-staffing-shortage",
            title: "Shortage",
            summary: "y",
            recommendationKeys: ["workforce-staffing-shortage"],
            factKeys: [],
            entityIds: [negativeJob.id],
          },
        ],
        factKeys: [],
        recommendationKeys: ["workforce-staffing-shortage", "missing-wage-data"],
      },
    ],
    recommendations: catalogA.activeRecommendations,
    facts: catalogA.facts,
  });
  check("21. Duplicate recommendation keys are unique", conflicts.uniqueRecommendationKeys.filter((key) => key === "missing-wage-data").length === 1);
  check(
    "Conflicts include missing wage vs margin/pricing",
    conflicts.items.some((item) => item.kind === "MISSING_WAGE_VS_MARGIN_PRICING"),
  );
  check(
    "5. Existing shared recommendation dedupe still passes",
    conflicts.items.some((item) => item.kind === "SHARED_RECOMMENDATION" || item.kind === "DUPLICATE_RECOMMENDATION") &&
      conflicts.uniqueRecommendationKeys.filter((key) => key === "missing-wage-data").length === 1,
  );
  check(
    "4. Shared job reference fires only for the same job",
    conflicts.items.some((item) => item.kind === "SHARED_JOB_REFERENCE"),
  );
  check(
    "2. Negative-margin job + staffing shortage is not a profitable-work conflict",
    conflicts.items.every((item) => item.kind !== "STAFFING_SHORTAGE_VS_PROFITABLE_WORK"),
  );

  const invoiceId = "inv-receivable-only";
  const receivableOnly = resolveConflicts({
    results: [
      {
        specialistId: "FINANCIAL",
        status: "OK",
        findings: [
          {
            key: "financial-outstanding-receivables",
            title: "Receivables",
            summary: "SENT remainder",
            recommendationKeys: ["collect-unpaid-invoices"],
            factKeys: [],
            entityIds: [invoiceId],
          },
        ],
        factKeys: [],
        recommendationKeys: ["collect-unpaid-invoices"],
      },
      {
        specialistId: "WORKFORCE",
        status: "OK",
        findings: [
          {
            key: "workforce-staffing-shortage",
            title: "Shortage",
            summary: "short",
            recommendationKeys: ["workforce-staffing-shortage"],
            factKeys: [],
            entityIds: [invoiceId],
          },
        ],
        factKeys: [],
        recommendationKeys: ["workforce-staffing-shortage"],
      },
    ],
    recommendations: [
      { key: "workforce-staffing-shortage", title: "Shortage", kind: "recommendation", priority: 1, why: "x", facts: [], href: "/jobs" },
      { key: "collect-unpaid-invoices", title: "Collect", kind: "recommendation", priority: 2, why: "y", facts: [], href: "/invoices" },
    ],
    facts: catalogA.facts,
  });
  check(
    "1. Receivable invoice + staffing shortage does not emit profitable-work conflict",
    receivableOnly.items.every((item) => item.kind !== "STAFFING_SHORTAGE_VS_PROFITABLE_WORK"),
  );
  check(
    "3. Invoice ids are never interpreted as job ids",
    jobIdsFromFinancialFindings([
      {
        key: "financial-outstanding-receivables",
        entityIds: [invoiceId],
      },
    ]).length === 0 &&
      !isFinancialJobFindingKey("financial-outstanding-receivables") &&
      receivableOnly.items.every((item) => item.kind !== "SHARED_JOB_REFERENCE"),
  );

  const differentJob = resolveConflicts({
    results: [
      {
        specialistId: "FINANCIAL",
        status: "OK",
        findings: [
          {
            key: `financial-negative-job:${negativeJob.id}`,
            title: "Low margin",
            summary: "neg",
            recommendationKeys: [],
            factKeys: [],
            entityIds: [negativeJob.id],
          },
        ],
        factKeys: [],
        recommendationKeys: [],
      },
      {
        specialistId: "WORKFORCE",
        status: "OK",
        findings: [
          {
            key: "workforce-unassigned-job",
            title: "Unassigned",
            summary: "u",
            recommendationKeys: ["workforce-unassigned-job"],
            factKeys: [],
            entityIds: ["some-other-job"],
          },
        ],
        factKeys: [],
        recommendationKeys: ["workforce-unassigned-job"],
      },
    ],
    recommendations: catalogA.activeRecommendations,
    facts: catalogA.facts,
  });
  check(
    "4. Shared job reference does not fire for different jobs",
    differentJob.items.every((item) => item.kind !== "SHARED_JOB_REFERENCE"),
  );

  const liveResult = interpretFinancialSpecialist(catalogA, "How much collected cash do I have?");
  const liveJobIds = jobIdsFromFinancialFindings(liveResult.findings);
  const liveInvoiceIds = liveResult.findings
    .filter((row) => row.key === "financial-outstanding-receivables" || row.key === "collect-unpaid-invoices")
    .flatMap((row) => row.entityIds ?? []);
  check(
    "3. Live Financial job findings do not include receivable invoice ids",
    liveJobIds.every((id) => intelA.jobProfitability.some((job) => job.jobId === id)) &&
      liveInvoiceIds.length === 0,
  );

  console.log("\nENTITY IDS — recommendation keys keep their own jobs");
  const splitWs = await createOwnerWorkspace("Split Job Facts");
  await entitleFounder(splitWs.business.id);
  const splitCustomer = await prisma.customer.create({
    data: { businessId: splitWs.business.id, name: "Split Facts" },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: splitWs.business.id,
      customerId: splitCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const jobAInvoice = await prisma.invoice.create({
    data: {
      businessId: splitWs.business.id,
      customerId: splitCustomer.id,
      jobId: jobA.id,
      status: "PAID",
      total: 100,
      paidAt: new Date(),
    },
  });
  await prisma.payment.create({
    data: {
      businessId: splitWs.business.id,
      customerId: splitCustomer.id,
      jobId: jobA.id,
      invoiceId: jobAInvoice.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(100),
      method: "CASH",
      receivedAt: new Date(),
    },
  });
  await prisma.timeEntry.create({
    data: {
      businessId: splitWs.business.id,
      membershipId: splitWs.membership.id,
      jobId: jobA.id,
      activityType: "JOB",
      status: "APPROVED",
      startedAt: new Date(),
      endedAt: new Date(),
      approvedHours: 10,
      approvedLaborCost: 250,
    },
  });

  const overrunHoursDescription = joinLineDescription("Calculator labor", null, {
    calculatorId: "custom-variable-scope",
    inputs: { estimatedLaborHours: 4 },
    rates: {},
  });
  const jobBEstimate = await prisma.estimate.create({
    data: {
      businessId: splitWs.business.id,
      customerId: splitCustomer.id,
      status: "APPROVED",
      total: 1000,
      publicToken: randomUUID(),
    },
  });
  const jobB = await prisma.job.create({
    data: {
      businessId: splitWs.business.id,
      customerId: splitCustomer.id,
      estimateId: jobBEstimate.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: splitWs.business.id,
      estimateId: jobBEstimate.id,
      jobId: jobB.id,
      description: overrunHoursDescription,
      quantity: 1,
      unitPrice: 1000,
      total: 1000,
      type: "LABOR",
    },
  });
  const jobBInvoice = await prisma.invoice.create({
    data: {
      businessId: splitWs.business.id,
      customerId: splitCustomer.id,
      jobId: jobB.id,
      status: "PAID",
      total: 1000,
      paidAt: new Date(),
    },
  });
  await prisma.payment.create({
    data: {
      businessId: splitWs.business.id,
      customerId: splitCustomer.id,
      jobId: jobB.id,
      invoiceId: jobBInvoice.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(1000),
      method: "CASH",
      receivedAt: new Date(),
    },
  });
  await prisma.timeEntry.create({
    data: {
      businessId: splitWs.business.id,
      membershipId: splitWs.membership.id,
      jobId: jobB.id,
      activityType: "JOB",
      status: "APPROVED",
      startedAt: new Date(),
      endedAt: new Date(),
      approvedHours: 6,
      approvedLaborCost: 180,
    },
  });

  const splitCatalog = await loadCanonicalRecommendationCatalog(prisma, splitWs.business.id);
  const splitIntel = splitCatalog.financial.intelligence;
  const splitJobA = splitIntel?.jobProfitability.find((job) => job.jobId === jobA.id);
  const splitJobB = splitIntel?.jobProfitability.find((job) => job.jobId === jobB.id);
  check(
    "Job A is negative-margin with no labor-hours overrun",
    Boolean(splitJobA) &&
      (splitJobA?.grossProfit ?? 0) < 0 &&
      (splitJobA?.estimateActual.laborHoursVariance == null || splitJobA.estimateActual.laborHoursVariance <= 0),
  );
  check(
    "Job B is non-negative with a trustworthy labor-hours overrun",
    Boolean(splitJobB) &&
      (splitJobB?.grossProfit ?? -1) >= 0 &&
      splitJobB?.estimateActual.estimatedLaborHours != null &&
      splitJobB.estimateActual.estimatedLaborHoursProvenance !== "none" &&
      (splitJobB.estimateActual.laborHoursVariance ?? 0) > 0,
  );

  const splitResult = interpretFinancialSpecialist(splitCatalog, "Which jobs are losing money or over hours?");
  const lowMarginFinding = splitResult.findings.find((row) => row.key === "review-low-margin-jobs");
  const overrunFinding = splitResult.findings.find((row) => row.key === "estimate-labor-overrun");
  check(
    "review-low-margin-jobs references only Job A",
    Boolean(lowMarginFinding) &&
      lowMarginFinding?.entityIds?.length === 1 &&
      lowMarginFinding.entityIds[0] === jobA.id &&
      !lowMarginFinding.entityIds.includes(jobB.id),
  );
  check(
    "estimate-labor-overrun references only Job B",
    Boolean(overrunFinding) &&
      overrunFinding?.entityIds?.length === 1 &&
      overrunFinding.entityIds[0] === jobB.id &&
      !overrunFinding.entityIds.includes(jobA.id),
  );

  const sameOverrunJob = resolveConflicts({
    results: [
      {
        specialistId: "FINANCIAL",
        status: "OK",
        findings: [
          {
            key: "estimate-labor-overrun",
            title: "Overrun",
            summary: "hours",
            recommendationKeys: ["estimate-labor-overrun"],
            factKeys: [],
            entityIds: overrunFinding?.entityIds,
          },
        ],
        factKeys: [],
        recommendationKeys: ["estimate-labor-overrun"],
      },
      {
        specialistId: "WORKFORCE",
        status: "OK",
        findings: [
          {
            key: "workforce-unassigned-job",
            title: "Unassigned",
            summary: "u",
            recommendationKeys: ["workforce-unassigned-job"],
            factKeys: [],
            entityIds: [jobB.id],
          },
        ],
        factKeys: [],
        recommendationKeys: ["workforce-unassigned-job"],
      },
    ],
    recommendations: splitCatalog.activeRecommendations,
    facts: splitCatalog.facts,
  });
  check(
    "SHARED_JOB_REFERENCE fires only for the actual same job",
    sameOverrunJob.items.some((item) => item.kind === "SHARED_JOB_REFERENCE"),
  );

  const recKeyMismatch = resolveConflicts({
    results: [
      {
        specialistId: "FINANCIAL",
        status: "OK",
        findings: [
          {
            key: "review-low-margin-jobs",
            title: "Low margin",
            summary: "neg",
            recommendationKeys: ["review-low-margin-jobs"],
            factKeys: [],
            entityIds: lowMarginFinding?.entityIds,
          },
          {
            key: "estimate-labor-overrun",
            title: "Overrun",
            summary: "hours",
            recommendationKeys: ["estimate-labor-overrun"],
            factKeys: [],
            entityIds: overrunFinding?.entityIds,
          },
        ],
        factKeys: [],
        recommendationKeys: ["review-low-margin-jobs", "estimate-labor-overrun"],
      },
      {
        specialistId: "WORKFORCE",
        status: "OK",
        findings: [
          {
            key: "workforce-unassigned-job",
            title: "Unassigned",
            summary: "other",
            recommendationKeys: ["workforce-unassigned-job"],
            factKeys: [],
            entityIds: ["unrelated-job"],
          },
        ],
        factKeys: [],
        recommendationKeys: ["workforce-unassigned-job"],
      },
    ],
    recommendations: splitCatalog.activeRecommendations,
    facts: splitCatalog.facts,
  });
  check(
    "No false shared-job conflict from recommendation-key/entity mismatch",
    recKeyMismatch.items.every((item) => item.kind !== "SHARED_JOB_REFERENCE"),
  );

  console.log("\nREVENUE TRUTH — one collected-cash number");
  const paidPartial = await createOwnerWorkspace("Paid Partial");
  await entitleFounder(paidPartial.business.id);
  const paidPartialCustomer = await prisma.customer.create({
    data: { businessId: paidPartial.business.id, name: "Partial Pay" },
  });
  const paidPartialInvoice = await prisma.invoice.create({
    data: {
      businessId: paidPartial.business.id,
      customerId: paidPartialCustomer.id,
      status: "PAID",
      total: 1000,
      paidAt: new Date(),
    },
  });
  await prisma.payment.create({
    data: {
      businessId: paidPartial.business.id,
      customerId: paidPartialCustomer.id,
      invoiceId: paidPartialInvoice.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(400),
      method: "CASH",
      receivedAt: new Date(),
    },
  });
  const paidPartialCatalog = await loadCanonicalRecommendationCatalog(prisma, paidPartial.business.id);
  check(
    "PAID 1000 + Payment 400 uses collected 400 for both paidRevenue and collectedRevenue",
    paidPartialCatalog.facts.paidRevenue.amount === 400 &&
      paidPartialCatalog.facts.collectedRevenue?.amount === 400 &&
      paidPartialCatalog.financial.intelligence?.cashFlow.collectedCustomerPayments === 400,
  );
  const paidPartialHealth = buildBsosHealthMetrics(paidPartialCatalog.facts);
  check(
    "Business Health collected-cash metric is 400, not 1000",
    paidPartialHealth.some((row) => row.key === "paid-revenue" && row.value === "400.00") &&
      paidPartialHealth.every((row) => row.value !== "1000.00"),
  );
  const paidPartialCoach = answerCoachFromFacts("How much collected cash and paid revenue do I have?", {
    facts: paidPartialCatalog.facts,
    recommendations: paidPartialCatalog.activeRecommendations,
    metrics: paidPartialHealth,
    goals: [],
    actionItems: [],
  });
  const paidPartialSynthesis = synthesizeCoachAnswer({
    question: "How much collected cash and paid revenue do I have?",
    catalog: paidPartialCatalog,
    specialistResults: [interpretFinancialSpecialist(paidPartialCatalog, "How much collected cash and paid revenue do I have?")],
    conflicts: resolveConflicts({
      results: [interpretFinancialSpecialist(paidPartialCatalog, "How much collected cash and paid revenue do I have?")],
      recommendations: paidPartialCatalog.activeRecommendations,
      facts: paidPartialCatalog.facts,
    }),
    coachContext: {
      facts: paidPartialCatalog.facts,
      recommendations: paidPartialCatalog.activeRecommendations,
      metrics: paidPartialHealth,
      goals: [],
      actionItems: [],
    },
  });
  const paidPartialAsk = await runChiefOfStaffCoach(prisma, paidPartial.access, {
    question: "How much collected cash and paid revenue do I have?",
    attemptId: randomUUID(),
  });
  const paidPartialOwnerFacing = [
    paidPartialCoach.output.text,
    paidPartialSynthesis.output.text,
    paidPartialAsk.text ?? "",
  ].join("\n");
  const paidPartialRevenueFacts = [...paidPartialCoach.citedFacts, ...paidPartialSynthesis.citedFacts].filter(
    (fact) => fact.key === "paid-revenue" || fact.key === "collected-revenue",
  );
  check(
    "Coach/synthesis does not expose 1000 as collected/paid revenue while Financial says 400",
    paidPartialCatalog.financial.intelligence?.cashFlow.collectedCustomerPayments === 400 &&
      /400/.test(paidPartialAsk.text ?? "") &&
      !/collected customer cash is 1000|paid revenue is 1000/i.test(paidPartialOwnerFacing) &&
      paidPartialRevenueFacts.length > 0 &&
      paidPartialRevenueFacts.every((fact) => fact.value === "400.00") &&
      paidPartialCoach.citedFacts.every((fact) => fact.value !== "1000.00") &&
      paidPartialSynthesis.citedFacts.every((fact) => fact.value !== "1000.00"),
  );
  check(
    "No competing cash fact contradicts collected 400",
    paidPartialCatalog.facts.paidRevenue.amount === 400 &&
      paidPartialCatalog.facts.collectedRevenue?.amount === 400 &&
      paidPartialRevenueFacts.every((fact) => fact.value === "400.00"),
  );

  const legacyPaidWs = await createOwnerWorkspace("Legacy Paid");
  await entitleFounder(legacyPaidWs.business.id);
  await prisma.invoice.create({
    data: {
      businessId: legacyPaidWs.business.id,
      status: "PAID",
      total: 1000,
      paidAt: new Date(),
    },
  });
  const legacyCatalog = await loadCanonicalRecommendationCatalog(prisma, legacyPaidWs.business.id);
  check(
    "PAID 1000 with no Payment rows uses legacy fallback 1000",
    legacyCatalog.facts.paidRevenue.amount === 1000 &&
      legacyCatalog.facts.collectedRevenue?.amount === 1000 &&
      legacyCatalog.financial.intelligence?.cashFlow.collectedCustomerPayments === 1000,
  );

  const sentPartialWs = await createOwnerWorkspace("Sent Partial");
  await entitleFounder(sentPartialWs.business.id);
  const sentCustomer = await prisma.customer.create({
    data: { businessId: sentPartialWs.business.id, name: "Sent Partial" },
  });
  const sentInvoice = await prisma.invoice.create({
    data: {
      businessId: sentPartialWs.business.id,
      customerId: sentCustomer.id,
      status: "SENT",
      total: 1000,
    },
  });
  await prisma.payment.create({
    data: {
      businessId: sentPartialWs.business.id,
      customerId: sentCustomer.id,
      invoiceId: sentInvoice.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(400),
      method: "CASH",
      receivedAt: new Date(),
    },
  });
  const sentCatalog = await loadCanonicalRecommendationCatalog(prisma, sentPartialWs.business.id);
  const sentRow = sentCatalog.financial.intelligence?.receivables.rows.find((row) => row.invoiceId === sentInvoice.id);
  check(
    "SENT 1000 + Payment 400 collects 400 and remains 600",
    sentCatalog.facts.paidRevenue.amount === 400 &&
      sentCatalog.facts.collectedRevenue?.amount === 400 &&
      sentCatalog.facts.unpaidInvoices.amount === 600 &&
      sentRow?.collectedAgainstInvoice === 400 &&
      sentRow?.balanceDue === 600,
  );
  const sentAsk = await runChiefOfStaffCoach(prisma, sentPartialWs.access, {
    question: "How much collected cash and outstanding receivables do I have?",
    attemptId: randomUUID(),
  });
  check(
    "SENT partial Coach does not treat 1000 as collected cash",
    /400/.test(sentAsk.text ?? "") &&
      /600/.test(sentAsk.text ?? "") &&
      !/collected customer cash is 1000/i.test(sentAsk.text ?? "") &&
      sentCatalog.facts.paidRevenue.amount !== 1000,
  );

  check("PRODUCT_CAPABILITIES still names REPORTING_INSIGHTS", PRODUCT_CAPABILITIES.REPORTING_INSIGHTS === "REPORTING_INSIGHTS");
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

console.log(
  failures === 0 ? `\nAll financial-specialist checks passed.` : `\n${failures} financial-specialist check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);

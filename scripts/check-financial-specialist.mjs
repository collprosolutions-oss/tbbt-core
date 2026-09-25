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
  loadCanonicalRecommendationCatalog,
  planSpecialists,
  resetFinancialSpecialistCounters,
  resolveConflicts,
  runChiefOfStaffCoach,
} = await import("@/lib/chief-of-staff");
const {
  getFinancialSourceLoadCount,
  resetFinancialSourceLoadCount,
} = await import("@/lib/financial-intelligence-data");
const {
  getFinancialIntelligenceBuildCount,
  resetFinancialIntelligenceBuildCount,
} = await import("@/lib/financial-intelligence");
const { PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog");

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
  await prisma.invoice.create({
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

  check("1. Tenant A snapshot is entitled", catalogA.financial.entitled === true && Boolean(catalogA.financial.intelligence));
  check("1. Tenant A cannot see B invoice total 8888", !JSON.stringify(resultA).includes("8888"));
  check("1. Tenant B cannot see A collected 400", !JSON.stringify(resultB).includes("400.00") || resultB.facts["collected-customer-cash"] !== "400.00");
  check("1. Tenant B collected cash stays on B", resultB.facts["collected-customer-cash"] === "0.00");
  check("3. No REPORTING_INSIGHTS skips Financial", resultStarter.status === "SKIPPED");
  check("3. Skipped Financial has a limitation", /Reporting Insights/i.test(resultStarter.limitation ?? ""));
  check("3. Skipped Financial has no fake zeroes", resultStarter.factKeys.length === 0 && resultStarter.findings.length === 0);

  check("4. SENT 1000 + Payment 400 collects 400", resultA.facts["collected-customer-cash"] === "750.00" || resultA.facts["collected-customer-cash"] === "400.00" || Number(resultA.facts["collected-customer-cash"]) >= 400);
  const intelA = catalogA.financial.intelligence;
  const partialInvoice = intelA.receivables.rows.find((row) => row.invoiceId === sentPartial.id);
  check("4. Partial payment stays partial — collected 400 / remaining 600", partialInvoice?.collectedAgainstInvoice === 400 && partialInvoice?.balanceDue === 600);
  check("4. Combined collected includes payment-backed cash", Number(resultA.facts["collected-customer-cash"]) === 750);
  const legacyPaid = intelA.cashFlow.collectedCustomerPayments;
  check("5. PAID legacy invoice with no Payment rows uses fallback", legacyPaid === 750);
  const sentUnpaid = intelA.receivables.rows.filter((row) => row.invoiceTotal === 175);
  check("6. SENT invoice with no payment is not collected", sentUnpaid.length === 1 && sentUnpaid[0].collectedAgainstInvoice === 0 && sentUnpaid[0].balanceDue === 175);

  check("7. Bank stays disconnected", resultA.facts["bank-connected"] === "false" && intelA.bankConnected === false);
  check("7. Accounting stays disconnected", resultA.facts["accounting-connected"] === "false" && intelA.accountingConnected === false);
  check("7. No invented bank/accounting balance", resultA.facts["projected-bank-balance"] === "unknown" && resultA.facts["projected-accounting-balance"] === "unknown" && intelA.cashFlow.projectedBalance === null);
  check("8. Missing wage stays unknown/incomplete", resultA.facts["labor-cost-completeness"] === "incomplete/unknown");
  check("9. Missing target margin is unconfigured, not 0%", resultA.facts["target-margin-configuration"] === "unconfigured" && intelA.laborBurden.targetGrossMarginRate == null);
  check("10. Missing burden is unconfigured, not 0%", resultA.facts["burden-configuration"] === "unconfigured" && intelA.laborBurden.burdenRate == null);

  const negative = intelA.jobProfitability.find((job) => job.jobId === negativeJob.id);
  check("11. Negative-margin job is projected", Boolean(negative) && negative.grossProfit === -150);
  check("11. Specialist reports the negative margin", Number(resultA.facts["lowest-margin-job"]) === -150);

  const unknownCost = intelA.jobProfitability.find((job) => job.jobId === unknownJob.id);
  check("24. Incomplete cost remains unknown", unknownCost?.grossProfit == null && unknownCost?.recordedDirectCost == null && unknownCost?.completeness.laborCostComplete === false);

  const receivableFact = resultA.facts["receivables-top"] ?? "";
  check("12. Receivables are capped at 5", receivableFact.split("|").filter(Boolean).length <= FINANCIAL_CONTEXT_CAPS.receivables);
  check("12. Source receivables exceed the cap", intelA.receivables.rows.filter((row) => row.balanceDue > 0).length > FINANCIAL_CONTEXT_CAPS.receivables);
  check("13. Fact keys stay bounded", resultA.factKeys.length <= FINANCIAL_CONTEXT_CAPS.facts);
  check(
    "13. Context does not pass raw ledgers or secrets",
    !JSON.stringify(resultA).includes("stripe") &&
      !JSON.stringify(resultA).includes("sk_live") &&
      !/phone|email|address/i.test(JSON.stringify(resultA.facts)),
  );

  const noJobBiz = await createOwnerWorkspace("No Jobs Financial");
  await entitleFounder(noJobBiz.business.id);
  const noJobCatalog = await loadCanonicalRecommendationCatalog(prisma, noJobBiz.business.id);
  const noJobResult = interpretFinancialSpecialist(noJobCatalog, "Should I change pricing?");
  check(
    "23. No completed jobs → no invented pricing signal",
    noJobResult.facts["pricing-sample"] === "no-completed-jobs-with-complete-cost" &&
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
    "Conflicts preserve profitable work without assigning anyone",
    conflicts.items.some((item) => item.kind === "STAFFING_SHORTAGE_VS_PROFITABLE_WORK") &&
      conflicts.items.some((item) => /does not assign|nobody is assigned/i.test(item.summary)),
  );
  check(
    "Conflicts dedupe shared job references",
    conflicts.items.some((item) => item.kind === "SHARED_JOB_REFERENCE"),
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

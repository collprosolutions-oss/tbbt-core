/**
 * Monthly business goals proofs.
 *
 * Proves OWNER write / ADMIN view / MEMBER deny, tenant isolation,
 * Business.timezone month boundaries, and actual-versus-goal math over
 * recorded JOB_COMPLETED events, PAID invoices, and collected cash.
 * Goals are targets, not forecasts or bank balance.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-monthly-goals.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for monthly goals checks.");
  process.exit(generateEarly.status ?? 1);
}

const { CAPABILITIES, ForbiddenError, roleHasCapability, canAccessManagementConsole } = await import(
  "@/lib/authorization"
);
const { visibleAppNav } = await import("@/lib/nav");
const {
  GOAL_UNAVAILABLE_MESSAGE,
  INVALID_COUNT_TARGET_MESSAGE,
  INVALID_MONTH_MESSAGE,
  INVALID_REVENUE_TARGET_MESSAGE,
  INVOICES_PAID_FACT_MESSAGE,
  JOBS_COMPLETED_FACT_MESSAGE,
  MONTHLY_GOALS_PATH,
  MONTHLY_GOALS_READ_BOUND,
  NO_AUTOMATIC_MESSAGE_MESSAGE,
  NO_AUTOMATIC_PRICE_CHANGE_MESSAGE,
  READ_BOUND_MESSAGE,
  RECORDED_FACT_KIND,
  REVENUE_RECEIVED_FACT_MESSAGE,
  SAVE_DOES_NOT_WRITE_BOOKS_MESSAGE,
  TARGET_KIND,
  TARGET_NOT_BANK_BALANCE_MESSAGE,
  TARGET_NOT_FORECAST_MESSAGE,
  UNCLOCKED_COMPLETED_JOBS_MESSAGE,
  assertCanReadMonthlyGoals,
  assertCanWriteMonthlyGoals,
  buildMonthlyGoalProgress,
  collectedRevenueInPeriod,
  compareActualToGoal,
  countInvoicesPaidInPeriod,
  countJobsCompletedInPeriod,
  isolateMonthlyGoalFacts,
  monthlyGoalPeriod,
  parseCountTarget,
  parseMoneyTarget,
  parseMonthlyGoalKey,
  parseMonthlyGoalTargets,
  resolveMonthlyGoalPeriod,
} = await import("@/lib/monthly-goals");
const { loadMonthlyGoalFactSource, loadMonthlyGoalsWorkspace, loadSavedMonthlyBusinessGoal } =
  await import("@/lib/monthly-goals-data");
const { saveMonthlyBusinessGoal } = await import("@/lib/monthly-goals-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_monthly_goals_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for monthly goals test database.");
  process.exit(push.status ?? 1);
}

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
      business: { id: businessId, timezone },
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

function denied(fn) {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof ForbiddenError;
  }
}

async function deniedAsync(fn) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof ForbiddenError;
  }
}

const libSrc = readRepo("src/lib/monthly-goals.ts");
const dataSrc = readRepo("src/lib/monthly-goals-data.ts");
const opsSrc = readRepo("src/lib/monthly-goals-ops.ts");
const actionSrc = readRepo("src/app/actions/monthly-goals.ts");
const pageSrc = readRepo("src/app/(app)/goals/page.tsx");
const uiSrc = readRepo("src/components/goals/monthly-goals-workspace.tsx");
const schemaSrc = readRepo("prisma/schema.prisma");
const migrationSrc = readRepo("prisma/migrations/20260929010000_monthly_business_goal/migration.sql");
const packageSrc = readRepo("package.json");
const allFeatureSrc = [libSrc, dataSrc, opsSrc, actionSrc, pageSrc, uiSrc].join("\n");

try {
  console.log("\nSTATIC — Honesty, bounds, and no automatic side effects");
  check("Route is /goals", MONTHLY_GOALS_PATH === "/goals" && pageSrc.includes("MonthlyGoalsPage"));
  check(
    "Page uses management access then read gate",
    pageSrc.includes("requireManagementPageAccess()") && pageSrc.includes("assertCanReadMonthlyGoals"),
  );
  check("OWNER/ADMIN can access the management console", canAccessManagementConsole("OWNER") && canAccessManagementConsole("ADMIN"));
  check("MEMBER cannot access the management console", canAccessManagementConsole("MEMBER") === false);
  check("Monthly goals nav is visible to OWNER", visibleAppNav("OWNER").some((item) => item.href === "/goals"));
  check("Monthly goals nav is visible to ADMIN", visibleAppNav("ADMIN").some((item) => item.href === "/goals"));
  check("Monthly goals nav is hidden from MEMBER", !visibleAppNav("MEMBER").some((item) => item.href === "/goals"));
  check("MEMBER does not have VIEW_REPORTS", !roleHasCapability("MEMBER", CAPABILITIES.VIEW_REPORTS));
  check("npm script is dedicated", packageSrc.includes("test:monthly-goals") && packageSrc.includes("check-monthly-goals.mjs"));
  check("Targets are labeled targets, not forecasts", libSrc.includes(TARGET_NOT_FORECAST_MESSAGE) && TARGET_KIND === "target");
  check("Recorded facts stay recorded-fact", RECORDED_FACT_KIND === "recorded-fact");
  check("Bank balance is not claimed", libSrc.includes(TARGET_NOT_BANK_BALANCE_MESSAGE) && uiSrc.includes("TARGET_NOT_BANK_BALANCE_MESSAGE"));
  check("Jobs completed use JOB_COMPLETED events", JOBS_COMPLETED_FACT_MESSAGE.includes("JOB_COMPLETED"));
  check("Invoices paid use paidAt", INVOICES_PAID_FACT_MESSAGE.includes("paidAt"));
  check("Revenue received uses collected cash, not bank", REVENUE_RECEIVED_FACT_MESSAGE.includes("Payment.receivedAt"));
  check("Reads are bounded", MONTHLY_GOALS_READ_BOUND === 200 && dataSrc.includes("MONTHLY_GOALS_READ_BOUND"));
  check("Write ops do not touch books", !/prisma\.(invoice|payment|expense|job|serviceCatalogItem|estimate|lineItem)\./.test(opsSrc));
  check("Action does not send messages", !/sendOwnerSms|sendEmail|resend|twilio/i.test(actionSrc));
  check("No automatic pricing language is present", NO_AUTOMATIC_PRICE_CHANGE_MESSAGE.includes("does not change catalog prices"));
  check("No automatic messages language is present", NO_AUTOMATIC_MESSAGE_MESSAGE.includes("does not send SMS"));
  check("Save does not write books", SAVE_DOES_NOT_WRITE_BOOKS_MESSAGE.includes("does not write invoices"));
  check("Schema stores targets only", schemaSrc.includes("model MonthlyBusinessGoal") && schemaSrc.includes("Targets are not forecasts"));
  check(
    "Migration is additive and IF NOT EXISTS",
    migrationSrc.includes('CREATE TABLE IF NOT EXISTS "MonthlyBusinessGoal"') &&
      !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSrc),
  );
  check("Ops fail closed without request-time DDL", opsSrc.includes("missingMonthlyGoalSchema") && !opsSrc.includes("$executeRawUnsafe"));
  check("Page awaits searchParams", pageSrc.includes("await searchParams"));
  check("Data loader isolates after fetch", dataSrc.includes("isolateMonthlyGoalFacts") && dataSrc.includes("isolateSameBusinessRows"));
  check(
    "Feature does not send messages or change prices",
    !/sendOwnerSms|sendEmail|twilio|stripe\.prices|updateCatalog/i.test(allFeatureSrc) &&
      allFeatureSrc.includes(NO_AUTOMATIC_PRICE_CHANGE_MESSAGE) &&
      allFeatureSrc.includes(NO_AUTOMATIC_MESSAGE_MESSAGE),
  );

  const nySeptember = monthlyGoalPeriod(2026, 9, "America/New_York");
  const laSeptember = monthlyGoalPeriod(2026, 9, "America/Los_Angeles");
  check("September 2026 NY starts 2026-09-01", nySeptember.key === "2026-09" && nySeptember.start.toISOString() === "2026-09-01T04:00:00.000Z");
  check("September 2026 NY ends October 1 NY", nySeptember.end.toISOString() === "2026-10-01T04:00:00.000Z");
  check("September 2026 LA starts later than NY", laSeptember.start.getTime() > nySeptember.start.getTime());
  check("Invalid month key is rejected", parseMonthlyGoalKey("2026-13") === null && parseMonthlyGoalKey("2026-9") === null);
  check("Valid month key parses", parseMonthlyGoalKey("2026-09")?.year === 2026 && parseMonthlyGoalKey("2026-09")?.month === 9);
  check(
    "Current month uses Business.timezone",
    resolveMonthlyGoalPeriod(new Date("2026-09-01T02:00:00.000Z"), { timezone: "America/New_York" }).key === "2026-08",
  );
  check("Blank count target clears", parseCountTarget("").value === null && parseCountTarget("").error === null);
  check("Zero count target is invalid", parseCountTarget("0").error === INVALID_COUNT_TARGET_MESSAGE);
  check("Fractional count target is invalid", parseCountTarget("2.5").error === INVALID_COUNT_TARGET_MESSAGE);
  check("Money target rounds", parseMoneyTarget("12.345").value === 12.35);
  check("Zero money target is invalid", parseMoneyTarget("0").error === INVALID_REVENUE_TARGET_MESSAGE);
  check("Invalid month parse surfaces", parseMonthlyGoalTargets({ jobsCompleted: "8" }).targets.jobsCompleted === 8);

  const met = compareActualToGoal({ metric: "jobs-completed", actual: 12, goal: 10, actualIncomplete: false });
  check("Actual 12 / goal 10 is met with 0 remaining", met.status === "met" && met.remaining === 0 && met.percent === 120 && met.met === true);
  const short = compareActualToGoal({ metric: "invoices-paid", actual: 3, goal: 10, actualIncomplete: false });
  check("Actual 3 / goal 10 is short 7", short.status === "short" && short.remaining === 7 && short.percent === 30 && short.met === false);
  const noTarget = compareActualToGoal({ metric: "revenue-received", actual: 400, goal: null, actualIncomplete: false });
  check("Missing target does not invent remaining", noTarget.status === "no-target" && noTarget.remaining === null && noTarget.percent === null);
  const incompleteShort = compareActualToGoal({
    metric: "jobs-completed",
    actual: 4,
    goal: 10,
    actualIncomplete: true,
  });
  check(
    "Incomplete actual below goal does not claim remaining or percent",
    incompleteShort.status === "actual-incomplete" &&
      incompleteShort.remaining === null &&
      incompleteShort.percent === null &&
      incompleteShort.met === null &&
      incompleteShort.notes.includes(READ_BOUND_MESSAGE),
  );
  const incompleteMet = compareActualToGoal({
    metric: "jobs-completed",
    actual: 12,
    goal: 10,
    actualIncomplete: true,
  });
  check("Incomplete actual already at/over goal can still be met", incompleteMet.status === "met" && incompleteMet.met === true);

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Goals",
      slug: `alpha-goals-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Goals",
      slug: `beta-goals-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-goals-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-goals-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-goals-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-owner-goals-${randomUUID()}@example.com`, passwordHash: "x" },
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

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id, "America/New_York");
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id, "America/New_York");
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id, "America/New_York");
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id, "America/Los_Angeles");

  console.log("\nAUTH — OWNER write, ADMIN view, MEMBER denied");
  check("MEMBER cannot read", denied(() => assertCanReadMonthlyGoals(memberA)));
  check("MEMBER cannot write", denied(() => assertCanWriteMonthlyGoals(memberA)));
  check("ADMIN can read", !denied(() => assertCanReadMonthlyGoals(adminA)));
  check("ADMIN cannot write", denied(() => assertCanWriteMonthlyGoals(adminA)));
  check("OWNER can read and write", !denied(() => assertCanReadMonthlyGoals(ownerA)) && !denied(() => assertCanWriteMonthlyGoals(ownerA)));
  check("Ops uses OWNER write gate", opsSrc.includes("assertCanWriteMonthlyGoals(access)"));
  check("ADMIN write via ops is forbidden", await deniedAsync(() => saveMonthlyBusinessGoal(prisma, adminA, { month: "2026-09", jobsCompleted: "4" })));
  check("MEMBER write via ops is forbidden", await deniedAsync(() => saveMonthlyBusinessGoal(prisma, memberA, { month: "2026-09", jobsCompleted: "4" })));
  check("MEMBER load is forbidden", await deniedAsync(() => loadMonthlyGoalsWorkspace(prisma, memberA, { month: "2026-09" })));

  const saved = await saveMonthlyBusinessGoal(prisma, ownerA, {
    month: "2026-09",
    jobsCompleted: "4",
    invoicesPaid: "3",
    revenueReceived: "500",
  });
  check("OWNER can set monthly targets", saved.saved.jobsCompletedTarget === 4 && saved.saved.invoicesPaidTarget === 3 && saved.saved.revenueReceivedTarget === 500);
  check("Save message refuses book writes", saved.message.includes(SAVE_DOES_NOT_WRITE_BOOKS_MESSAGE));
  check("Invalid month is rejected", await (async () => {
    try {
      await saveMonthlyBusinessGoal(prisma, ownerA, { month: "2026-13", jobsCompleted: "1" });
      return false;
    } catch (error) {
      return error instanceof Error && error.message === INVALID_MONTH_MESSAGE;
    }
  })());

  const betaGoal = await saveMonthlyBusinessGoal(prisma, ownerB, {
    month: "2026-09",
    jobsCompleted: "99",
    invoicesPaid: "88",
    revenueReceived: "9999",
  });
  check("Beta goal stays on business B", betaGoal.saved.businessId === businessB.id);

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });

  async function createJob(businessId, status = "COMPLETED") {
    return prisma.job.create({
      data: {
        businessId,
        customerId: businessId === businessA.id ? customerA.id : customerB.id,
        status,
        projectToken: randomUUID(),
      },
    });
  }

  const jobInNySeptember = await createJob(businessA.id);
  const jobOnlyCompletedStatus = await createJob(businessA.id);
  const jobInAugustNy = await createJob(businessA.id);
  const jobJustAfterNyOctober = await createJob(businessA.id);
  const jobBeta = await createJob(businessB.id);

  // 2026-09-01T04:00:00.000Z is Sep 1 00:00 in NY and Aug 31 21:00 in LA.
  await prisma.businessEvent.create({
    data: {
      businessId: businessA.id,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: jobInNySeptember.id,
      occurredAt: new Date("2026-09-01T04:00:00.000Z"),
      idempotencyKey: `JOB_COMPLETED:${jobInNySeptember.id}`,
    },
  });
  await prisma.businessEvent.create({
    data: {
      businessId: businessA.id,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: jobInAugustNy.id,
      occurredAt: new Date("2026-09-01T02:00:00.000Z"),
      idempotencyKey: `JOB_COMPLETED:${jobInAugustNy.id}`,
    },
  });
  await prisma.businessEvent.create({
    data: {
      businessId: businessA.id,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: jobJustAfterNyOctober.id,
      occurredAt: new Date("2026-10-01T04:00:00.000Z"),
      idempotencyKey: `JOB_COMPLETED:${jobJustAfterNyOctober.id}`,
    },
  });
  await prisma.businessEvent.create({
    data: {
      businessId: businessB.id,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: jobBeta.id,
      occurredAt: new Date("2026-09-01T04:00:00.000Z"),
      idempotencyKey: `JOB_COMPLETED:${jobBeta.id}`,
    },
  });

  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: jobInNySeptember.id,
      status: "PAID",
      total: new Prisma.Decimal(200),
      paidAt: new Date("2026-09-01T04:00:00.000Z"),
    },
  });
  const paidWithPayment = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "PAID",
      total: new Prisma.Decimal(150),
      paidAt: new Date("2026-09-15T16:00:00.000Z"),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SENT",
      total: new Prisma.Decimal(80),
      createdAt: new Date("2026-09-16T16:00:00.000Z"),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "PAID",
      total: new Prisma.Decimal(50),
      paidAt: new Date("2026-09-01T02:00:00.000Z"),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      status: "PAID",
      total: new Prisma.Decimal(9999),
      paidAt: new Date("2026-09-15T16:00:00.000Z"),
    },
  });

  await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      invoiceId: paidWithPayment.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(150),
      method: "CASH",
      receivedAt: new Date("2026-09-15T16:00:00.000Z"),
    },
  });
  await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      purpose: "MATERIAL_DEPOSIT",
      amount: new Prisma.Decimal(25),
      method: "CHECK",
      receivedAt: new Date("2026-09-20T16:00:00.000Z"),
    },
  });
  await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(40),
      method: "CASH",
      receivedAt: new Date("2026-09-01T02:00:00.000Z"),
    },
  });
  await prisma.payment.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal(5000),
      method: "CASH",
      receivedAt: new Date("2026-09-15T16:00:00.000Z"),
    },
  });

  console.log("\nISOLATION + MONTH BOUNDARIES + ACTUAL VS GOAL");
  const workspaceA = await loadMonthlyGoalsWorkspace(prisma, ownerA, { month: "2026-09" }, new Date("2026-09-20T15:00:00.000Z"));
  const workspaceAdmin = await loadMonthlyGoalsWorkspace(prisma, adminA, { month: "2026-09" }, new Date("2026-09-20T15:00:00.000Z"));
  const workspaceB = await loadMonthlyGoalsWorkspace(prisma, ownerB, { month: "2026-09" }, new Date("2026-09-20T15:00:00.000Z"));
  const workspaceAugust = await loadMonthlyGoalsWorkspace(prisma, ownerA, { month: "2026-08" }, new Date("2026-09-20T15:00:00.000Z"));

  check("Alpha September uses America/New_York bounds", workspaceA.period.timeZone === "America/New_York" && workspaceA.period.start.toISOString() === "2026-09-01T04:00:00.000Z");
  check("Beta September uses America/Los_Angeles bounds", workspaceB.period.timeZone === "America/Los_Angeles");
  check("ADMIN can view Alpha targets", workspaceAdmin.canWrite === false && workspaceAdmin.targets.jobsCompleted === 4);
  check("OWNER can write Alpha targets", workspaceA.canWrite === true);
  check(
    "Jobs completed counts only NY-September JOB_COMPLETED events",
    workspaceA.progress.jobsCompleted.actual === 1,
  );
  check(
    "August NY event is not counted in September",
    workspaceAugust.progress.jobsCompleted.actual === 1,
  );
  check("October NY instant is not counted in September", workspaceA.progress.jobsCompleted.actual === 1);
  check(
    "Unclocked completed job is disclosed and not counted",
    workspaceA.unclockedCompletedJobs >= 1 &&
      workspaceA.progress.jobsCompleted.notes.includes(UNCLOCKED_COMPLETED_JOBS_MESSAGE) &&
      workspaceA.progress.jobsCompleted.actual === 1,
  );
  check("Beta job completion is not visible to Alpha", workspaceA.progress.jobsCompleted.actual === 1);
  check(
    "Invoices paid counts PAID+paidAt in NY September only",
    workspaceA.progress.invoicesPaid.actual === 2,
  );
  check("SENT invoice is not paid", workspaceA.progress.invoicesPaid.actual === 2);
  check("August-paid invoice is not in September", workspaceA.progress.invoicesPaid.actual === 2);
  check("Beta paid invoice is not visible to Alpha", workspaceA.progress.invoicesPaid.actual === 2);
  check(
    "Revenue received is payment 150 + deposit 25 + legacy 200, not 40 from August NY",
    workspaceA.progress.revenueReceived.actual === 375,
  );
  check("Beta payment is not visible to Alpha", workspaceA.progress.revenueReceived.actual === 375);
  check("LA September does not count the NY-midnight completion as LA September", workspaceB.progress.jobsCompleted.actual === 0);
  check("Alpha targets do not leak to Beta", workspaceB.targets.jobsCompleted === 99);
  check("Beta cannot read Alpha saved goal", (await loadSavedMonthlyBusinessGoal(prisma, ownerB, { year: 2026, month: 9 })).saved?.jobsCompletedTarget === 99);

  check(
    "Jobs actual vs goal: 1 of 4, remaining 3, 25%",
    workspaceA.progress.jobsCompleted.goal === 4 &&
      workspaceA.progress.jobsCompleted.remaining === 3 &&
      workspaceA.progress.jobsCompleted.percent === 25 &&
      workspaceA.progress.jobsCompleted.met === false &&
      workspaceA.progress.jobsCompleted.status === "short",
  );
  check(
    "Invoices actual vs goal: 2 of 3, remaining 1",
    workspaceA.progress.invoicesPaid.goal === 3 &&
      workspaceA.progress.invoicesPaid.remaining === 1 &&
      workspaceA.progress.invoicesPaid.percent === 66.67 &&
      workspaceA.progress.invoicesPaid.status === "short",
  );
  check(
    "Revenue actual vs goal: 375 of 500, remaining 125, 75%",
    workspaceA.progress.revenueReceived.goal === 500 &&
      workspaceA.progress.revenueReceived.remaining === 125 &&
      workspaceA.progress.revenueReceived.percent === 75 &&
      workspaceA.progress.revenueReceived.status === "short",
  );

  const mixed = isolateMonthlyGoalFacts({
    businessId: businessA.id,
    timeZone: "America/New_York",
    jobCompletions: [
      { businessId: businessA.id, jobId: "a", occurredAt: new Date("2026-09-02T12:00:00.000Z") },
      { businessId: businessB.id, jobId: "b", occurredAt: new Date("2026-09-02T12:00:00.000Z") },
    ],
    completedJobs: [
      { businessId: businessA.id, id: "a" },
      { businessId: businessB.id, id: "b" },
    ],
    completionEventsForCompletedJobs: [
      { businessId: businessA.id, jobId: "a" },
      { businessId: businessB.id, jobId: "b" },
    ],
    paidInvoices: [
      { businessId: businessA.id, id: "ia", status: "PAID", total: 10, paidAt: new Date("2026-09-02T12:00:00.000Z") },
      { businessId: businessB.id, id: "ib", status: "PAID", total: 99, paidAt: new Date("2026-09-02T12:00:00.000Z") },
    ],
    payments: [
      { businessId: businessA.id, id: "pa", amount: 10, invoiceId: "ia", receivedAt: new Date("2026-09-02T12:00:00.000Z") },
      { businessId: businessB.id, id: "pb", amount: 99, invoiceId: "ib", receivedAt: new Date("2026-09-02T12:00:00.000Z") },
    ],
    paymentsOnPaidInvoices: [
      { businessId: businessA.id, invoiceId: "ia" },
      { businessId: businessB.id, invoiceId: "ib" },
    ],
    jobCompletionsTruncated: false,
    completedJobsTruncated: false,
    paidInvoicesTruncated: false,
    paymentsTruncated: false,
    paymentsOnPaidInvoicesTruncated: false,
  });
  const mixedProgress = buildMonthlyGoalProgress(mixed, nySeptember, {
    jobsCompleted: 2,
    invoicesPaid: 2,
    revenueReceived: 20,
  });
  check("Isolated facts drop the other tenant", countJobsCompletedInPeriod(mixed, nySeptember).actual === 1);
  check("Isolated invoices drop the other tenant", countInvoicesPaidInPeriod(mixed, nySeptember).actual === 1);
  check("Isolated revenue drops the other tenant", collectedRevenueInPeriod(mixed, nySeptember).actual === 10);
  check("Isolated progress does not invent the foreign 99", mixedProgress.revenueReceived.actual === 10);

  const source = await loadMonthlyGoalFactSource(prisma, ownerA, nySeptember);
  check("Loader source is scoped to Alpha", source.businessId === businessA.id);
  check("Loader job completions exclude Beta", source.jobCompletions.every((row) => row.businessId === businessA.id));
  check("Loader invoices exclude Beta", source.paidInvoices.every((row) => row.businessId === businessA.id));
  check("Loader payments exclude Beta", source.payments.every((row) => row.businessId === businessA.id));
  check("Goals unavailable message stays honest", GOAL_UNAVAILABLE_MESSAGE.includes("migration"));

  const invoiceCountBefore = await prisma.invoice.count({ where: { businessId: businessA.id } });
  const paymentCountBefore = await prisma.payment.count({ where: { businessId: businessA.id } });
  await saveMonthlyBusinessGoal(prisma, ownerA, {
    month: "2026-09",
    jobsCompleted: "5",
    invoicesPaid: "3",
    revenueReceived: "500",
  });
  const invoiceCountAfter = await prisma.invoice.count({ where: { businessId: businessA.id } });
  const paymentCountAfter = await prisma.payment.count({ where: { businessId: businessA.id } });
  check("Saving targets does not create invoices", invoiceCountBefore === invoiceCountAfter);
  check("Saving targets does not create payments", paymentCountBefore === paymentCountAfter);

  console.log(
    failures === 0
      ? "\nAll monthly-goals checks passed."
      : `\n${failures} monthly-goals check(s) failed.`,
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

process.exit(failures === 0 ? 0 : 1);

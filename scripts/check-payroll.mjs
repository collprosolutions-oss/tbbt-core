/**
 * Payroll domain + authorization verification.
 *
 * Imports the REAL production helpers from src/lib/payroll.ts and
 * src/lib/payroll-ops.ts (same functions the server actions call).
 * Time Cards ops are used only to produce APPROVED TimesheetWeek
 * snapshots -- payroll must consume those, not rebuild them.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-payroll.mjs
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
} = await import("@/lib/authorization");
const { weekRange } = await import("@/lib/time-cards");
const {
  approveTimesheetWeek,
  createManualTimeEntry,
  reopenTimesheetWeek,
  updateMembershipWage,
} = await import("@/lib/time-card-ops");
const {
  BLOCKING_PAYROLL_EXCEPTIONS,
  canTransitionPayroll,
  defaultPayPeriod,
  derivePayrollRunStatus,
  evaluateItemExceptions,
  isLockedPayrollStatus,
  itemReadiness,
  parsePayPeriodDates,
  snapshotGrossLaborAmount,
  splitRegularAndOvertime,
} = await import("@/lib/payroll");
const {
  addPayrollItem,
  authorizePayrollRun,
  cancelPayrollRun,
  createPayrollRun,
  markPayrollProcessedExternally,
  PayrollError,
  reviewPayrollRun,
} = await import("@/lib/payroll-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_payroll_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for payroll test database.");
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

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
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

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3_600_000);
}

async function addPaidHours(access, membershipId, jobId, hours, activityType = "JOB") {
  return createManualTimeEntry(prisma, access, {
    membershipId,
    activityType,
    jobId: activityType === "JOB" ? jobId : undefined,
    startedAt: hoursAgo(hours + 1),
    endedAt: hoursAgo(1),
    note: `${activityType} ${hours}h`,
  });
}

try {
  console.log("\nSTATIC — Payroll domain helpers");
  check("Gross is hours × wage", snapshotGrossLaborAmount(8, 25) === 200);
  check("Gross prefers approved labor-cost snapshot", snapshotGrossLaborAmount(8, 25, 199.5) === 199.5);
  check("Gross is null without wage", snapshotGrossLaborAmount(8, null) === null);
  check("BREAK-excluded hours still compute 8 × 25", snapshotGrossLaborAmount(8, 25) === 200);
  const split = splitRegularAndOvertime(42);
  check("OT split is informational 40 + 2", split.regularHours === 40 && split.overtimeHours === 2);
  check("OT does not change gross (no 1.5x)", snapshotGrossLaborAmount(42, 20) === 840);
  check("Missing wage is blocking", BLOCKING_PAYROLL_EXCEPTIONS.includes("MISSING_WAGE"));
  check("Inactive worker with hours is not blocking", !BLOCKING_PAYROLL_EXCEPTIONS.includes("WORKER_INACTIVE_WITH_HOURS"));
  const missingWage = evaluateItemExceptions({
    timesheetStatus: "APPROVED",
    approvedHours: 8,
    approvedHourlyWage: null,
    membershipActive: true,
    alreadyFinalized: false,
    payrollStatus: "DRAFT",
  });
  check("Missing wage raises Needs Attention", itemReadiness(missingWage) === "NEEDS_ATTENTION" && missingWage.includes("MISSING_WAGE"));
  check("Authorized is locked", isLockedPayrollStatus("AUTHORIZED") && isLockedPayrollStatus("PROCESSED"));
  check("Draft is not locked", !isLockedPayrollStatus("DRAFT"));
  check("Authorize only from REVIEWED", canTransitionPayroll("REVIEWED", "AUTHORIZED") && !canTransitionPayroll("DRAFT", "AUTHORIZED"));
  check("Processed is distinct from Authorized", canTransitionPayroll("AUTHORIZED", "PROCESSED"));
  check("Invalid range is rejected", "error" in parsePayPeriodDates("2026-08-30", "2026-08-20"));
  const period = defaultPayPeriod(new Date(2026, 7, 31));
  check("Default period is a week, not a hardcoded business-wide weekly rule", period.end.getTime() - period.start.getTime() === 7 * 24 * 60 * 60 * 1000);
  check("OWNER/ADMIN have MANAGE_PAYROLL", roleHasCapability("OWNER", CAPABILITIES.MANAGE_PAYROLL) && roleHasCapability("ADMIN", CAPABILITIES.MANAGE_PAYROLL));
  check("MEMBER does not have MANAGE_PAYROLL", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_PAYROLL));
  check("Only OWNER has AUTHORIZE_PAYROLL", roleHasCapability("OWNER", CAPABILITIES.AUTHORIZE_PAYROLL) && !roleHasCapability("ADMIN", CAPABILITIES.AUTHORIZE_PAYROLL));
  check(
    "Ready items derive READY_FOR_REVIEW",
    derivePayrollRunStatus({ currentStatus: "DRAFT", itemCount: 1, items: [{ readiness: "READY" }] }) === "READY_FOR_REVIEW",
  );

  const businessA = await prisma.business.create({
    data: { name: "Alpha Payroll", slug: "alpha-payroll", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Payroll", slug: "beta-payroll", tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: "owner-payroll@example.com", passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: "admin-payroll@example.com", passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: "member-payroll@example.com", passwordHash: "x" },
  });
  const helperUser = await prisma.user.create({
    data: { name: "Hank Helper", email: "helper-payroll@example.com", passwordHash: "x" },
  });
  const nowageUser = await prisma.user.create({
    data: { name: "Nina Nowage", email: "nowage-payroll@example.com", passwordHash: "x" },
  });
  const inactiveUser = await prisma.user.create({
    data: { name: "Ivan Inactive", email: "inactive-payroll@example.com", passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: "beta-owner-payroll@example.com", passwordHash: "x" },
  });
  const betaMember = await prisma.user.create({
    data: { name: "Ben Member", email: "beta-member-payroll@example.com", passwordHash: "x" },
  });

  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER", hourlyWage: new Prisma.Decimal(25) },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN", hourlyWage: new Prisma.Decimal(22) },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(20) },
  });
  const helperMem = await prisma.membership.create({
    data: { userId: helperUser.id, businessId: businessA.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(18) },
  });
  const nowageMem = await prisma.membership.create({
    data: { userId: nowageUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const inactiveMem = await prisma.membership.create({
    data: { userId: inactiveUser.id, businessId: businessA.id, role: "MEMBER", active: false, hourlyWage: new Prisma.Decimal(15) },
  });
  await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER", hourlyWage: new Prisma.Decimal(40) },
  });
  const betaMemberMem = await prisma.membership.create({
    data: { userId: betaMember.id, businessId: businessB.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(30) },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const betaOwnerAccess = makeAccess(businessB.id, "OWNER", (
    await prisma.membership.findFirst({ where: { userId: betaOwner.id, businessId: businessB.id } })
  ).id);

  const jobA = await prisma.job.create({
    data: { businessId: businessA.id, status: "SCHEDULED", projectToken: randomUUID(), assignedMembershipId: memberMem.id },
  });
  const jobHelper = await prisma.job.create({
    data: { businessId: businessA.id, status: "SCHEDULED", projectToken: randomUUID(), assignedMembershipId: helperMem.id },
  });
  const jobNowage = await prisma.job.create({
    data: { businessId: businessA.id, status: "SCHEDULED", projectToken: randomUUID(), assignedMembershipId: nowageMem.id },
  });
  const jobInactive = await prisma.job.create({
    data: { businessId: businessA.id, status: "SCHEDULED", projectToken: randomUUID(), assignedMembershipId: inactiveMem.id },
  });
  const jobB = await prisma.job.create({
    data: { businessId: businessB.id, status: "SCHEDULED", projectToken: randomUUID(), assignedMembershipId: betaMemberMem.id },
  });

  const weekStart = weekRange(new Date()).start;
  const period = { payPeriodStart: weekStart, payPeriodEnd: new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000) };

  console.log("\nTEST — Time Cards handoff: only APPROVED weeks feed payroll");
  await addPaidHours(ownerA, memberMem.id, jobA.id, 8, "JOB");
  await createManualTimeEntry(prisma, ownerA, {
    membershipId: memberMem.id,
    activityType: "BREAK",
    startedAt: hoursAgo(10),
    endedAt: hoursAgo(9),
    note: "Lunch",
  });
  const unapprovedWeek = await prisma.timesheetWeek.create({
    data: {
      businessId: businessA.id,
      membershipId: helperMem.id,
      weekStartedAt: weekStart,
      status: "OPEN",
    },
  });
  await addPaidHours(ownerA, helperMem.id, jobHelper.id, 6, "JOB");
  const approvedMember = await approveTimesheetWeek(prisma, ownerA, {
    membershipId: memberMem.id,
    weekStartedAt: weekStart,
  });
  check("Member week approved", approvedMember.status === "APPROVED");
  check("Approved hours exclude BREAK", Number(approvedMember.approvedHours.toString()) === 8);

  const draft = await createPayrollRun(prisma, adminA, period);
  const includedIds = draft.items.map((item) => item.timesheetWeekId);
  check("Approved TimesheetWeek is included", includedIds.includes(approvedMember.id));
  check("Unapproved week is not included", !includedIds.includes(unapprovedWeek.id));
  const memberItem = draft.items.find((item) => item.membershipId === memberMem.id);
  check("Wage snapshot comes from approved Time Cards", Number(memberItem.approvedHourlyWage.toString()) === 25);
  check("Gross is approved hours × snapshot wage", Number(memberItem.grossLaborAmount.toString()) === 200);
  check("OT hours informational (0 for 8h)", Number(memberItem.overtimeHours.toString()) === 0);

  console.log("\nTEST — Missing wage, inactive historical hours, reopen");
  await addPaidHours(ownerA, nowageMem.id, jobNowage.id, 4, "JOB");
  await approveTimesheetWeek(prisma, ownerA, { membershipId: nowageMem.id, weekStartedAt: weekStart });
  await addPaidHours(ownerA, inactiveMem.id, jobInactive.id, 3, "JOB");
  await approveTimesheetWeek(prisma, ownerA, { membershipId: inactiveMem.id, weekStartedAt: weekStart });
  const withAttention = await createPayrollRun(prisma, ownerA, period);
  const nowageItem = withAttention.items.find((item) => item.membershipId === nowageMem.id);
  const inactiveItem = withAttention.items.find((item) => item.membershipId === inactiveMem.id);
  check("Missing wage item is present and Needs Attention", nowageItem?.readiness === "NEEDS_ATTENTION");
  check("Missing wage exception recorded", JSON.stringify(nowageItem.exceptions).includes("MISSING_WAGE"));
  check("Inactive worker with approved hours is still included", Boolean(inactiveItem));
  check("Inactive historical hours do not block inclusion", inactiveItem && Number(inactiveItem.approvedHours.toString()) === 3);

  await reopenTimesheetWeek(prisma, ownerA, {
    membershipId: memberMem.id,
    weekStartedAt: weekStart,
    reason: "Fix a clock",
  });
  const afterReopen = await prisma.payrollRunItem.findFirst({
    where: { payrollRunId: withAttention.id, membershipId: memberMem.id },
  });
  const afterReopenRun = await prisma.payrollRun.findUnique({ where: { id: withAttention.id } });
  check("Reopened week is no longer falsely Payroll Ready", afterReopen.readiness === "NEEDS_ATTENTION");
  check("Reopen exception is recorded", JSON.stringify(afterReopen.exceptions).includes("TIMESHEET_REOPENED"));
  check("Run drops out of ready/reviewed after reopen", afterReopenRun.status === "DRAFT");

  await approveTimesheetWeek(prisma, ownerA, { membershipId: memberMem.id, weekStartedAt: weekStart });

  console.log("\nTEST — Snapshot integrity after later wage change");
  const snapshotRun = await createPayrollRun(prisma, ownerA, period);
  const beforeWage = snapshotRun.items.find((item) => item.membershipId === memberMem.id);
  await updateMembershipWage(prisma, ownerA, { membershipId: memberMem.id, hourlyWage: "99.00" });
  const afterWage = await prisma.payrollRunItem.findUnique({ where: { id: beforeWage.id } });
  check("Later wage change does not rewrite payroll-run snapshot", Number(afterWage.approvedHourlyWage.toString()) === 25);
  const liveWage = await prisma.membership.findUnique({ where: { id: memberMem.id } });
  check("Current membership wage did change", Number(liveWage.hourlyWage.toString()) === 99);

  console.log("\nTEST — Authorization, lock, duplicate, processed");
  const cleanPeriod = {
    payPeriodStart: new Date(weekStart.getTime() + 14 * 24 * 60 * 60 * 1000),
    payPeriodEnd: new Date(weekStart.getTime() + 21 * 24 * 60 * 60 * 1000),
  };
  const futureWeek = new Date(weekStart.getTime() + 14 * 24 * 60 * 60 * 1000);
  await createManualTimeEntry(prisma, ownerA, {
    membershipId: helperMem.id,
    activityType: "JOB",
    jobId: jobHelper.id,
    startedAt: new Date(futureWeek.getTime() + 9 * 60 * 60 * 1000),
    endedAt: new Date(futureWeek.getTime() + 17 * 60 * 60 * 1000),
    note: "Future week job",
  });
  const futureApproved = await approveTimesheetWeek(prisma, ownerA, {
    membershipId: helperMem.id,
    weekStartedAt: futureWeek,
  });
  const authRun = await createPayrollRun(prisma, adminA, cleanPeriod);
  check("Future-period run includes only that week's approved card", authRun.items.length === 1 && authRun.items[0].timesheetWeekId === futureApproved.id);
  check("Clean run is READY_FOR_REVIEW", authRun.status === "READY_FOR_REVIEW");

  await expectError(
    "ADMIN cannot authorize payroll",
    () => authorizePayrollRun(prisma, adminA, { payrollRunId: authRun.id, confirmed: true }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "Authorize without confirmation is rejected",
    () => authorizePayrollRun(prisma, ownerA, { payrollRunId: authRun.id, confirmed: false }),
    (error) => error instanceof PayrollError,
  );
  await expectError(
    "Authorize before review is rejected",
    () => authorizePayrollRun(prisma, ownerA, { payrollRunId: authRun.id, confirmed: true }),
    (error) => error instanceof PayrollError,
  );

  const reviewed = await reviewPayrollRun(prisma, adminA, { payrollRunId: authRun.id });
  check("ADMIN can mark reviewed", reviewed.status === "REVIEWED");
  const authorized = await authorizePayrollRun(prisma, ownerA, { payrollRunId: authRun.id, confirmed: true });
  check("OWNER authorization locks the run", authorized.status === "AUTHORIZED");
  check("Authorization froze worker/hours/gross snapshots", authorized.authorizedWorkerCount === 1 && Number(authorized.authorizedGrossLaborAmount.toString()) === 144);
  const authEvent = await prisma.payrollRunEvent.findFirst({
    where: { payrollRunId: authRun.id, action: "AUTHORIZE" },
  });
  check("Authorization is audited", Boolean(authEvent?.actorMembershipId === ownerMem.id && authEvent.nextJson));

  await expectError(
    "Locked run cannot add another week",
    () => addPayrollItem(prisma, ownerA, { payrollRunId: authRun.id, timesheetWeekId: approvedMember.id }),
    (error) => error instanceof PayrollError,
  );

  const duplicate = await createPayrollRun(prisma, ownerA, cleanPeriod);
  check("Duplicate approved week is not included in a second run", duplicate.items.length === 0);
  await expectError(
    "Cannot add a week already consumed by a finalized run",
    () => addPayrollItem(prisma, ownerA, { payrollRunId: duplicate.id, timesheetWeekId: futureApproved.id }),
    (error) => error instanceof PayrollError,
  );

  await expectError(
    "Processed without confirmation is rejected",
    () => markPayrollProcessedExternally(prisma, ownerA, { payrollRunId: authRun.id, confirmed: false }),
    (error) => error instanceof PayrollError,
  );
  const processed = await markPayrollProcessedExternally(prisma, ownerA, {
    payrollRunId: authRun.id,
    confirmed: true,
    providerReference: "ADP-EXT-1",
  });
  check("Processed is distinct from Authorized", processed.status === "PROCESSED" && processed.processedSource === "MANUAL_EXTERNAL");
  const processedEvent = await prisma.payrollRunEvent.findFirst({
    where: { payrollRunId: authRun.id, action: "MARK_PROCESSED" },
  });
  check("Manual processed is audited as external", processedEvent?.reason === "Processed externally / recorded manually");

  const history = await prisma.payrollRun.findUnique({ where: { id: authRun.id } });
  await updateMembershipWage(prisma, ownerA, { membershipId: helperMem.id, hourlyWage: "50.00" });
  const historyAfter = await prisma.payrollRun.findUnique({ where: { id: authRun.id }, include: { items: true } });
  check("History preserves authorized gross after later wage change", Number(historyAfter.authorizedGrossLaborAmount.toString()) === Number(history.authorizedGrossLaborAmount.toString()));
  check("History item wage snapshot unchanged", Number(historyAfter.items[0].approvedHourlyWage.toString()) === 18);

  console.log("\nTEST — Permissions, isolation, cancel");
  await expectError(
    "MEMBER cannot create a payroll run",
    () => createPayrollRun(prisma, memberA, period),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot pass MANAGE_PAYROLL",
    () => {
      requireBusinessCapability(memberA, CAPABILITIES.MANAGE_PAYROLL);
    },
    (error) => error instanceof ForbiddenError,
  );

  await createManualTimeEntry(prisma, betaOwnerAccess, {
    membershipId: betaMemberMem.id,
    activityType: "TRAVEL",
    startedAt: hoursAgo(3),
    endedAt: hoursAgo(2),
    note: "Beta travel",
  });
  await approveTimesheetWeek(prisma, betaOwnerAccess, {
    membershipId: betaMemberMem.id,
    weekStartedAt: weekStart,
  });
  const betaRun = await createPayrollRun(prisma, betaOwnerAccess, period);
  check("Business B run stays on B", betaRun.businessId === businessB.id);
  const leaked = await prisma.payrollRun.findFirst({
    where: { id: betaRun.id, businessId: businessA.id },
  });
  check("Business A cannot load Business B payroll run by id", leaked === null);
  await expectError(
    "Business A cannot add Business B's approved week",
    () => addPayrollItem(prisma, ownerA, { payrollRunId: snapshotRun.id, timesheetWeekId: betaRun.items[0]?.timesheetWeekId ?? "missing" }),
    (error) => error instanceof PayrollError || error instanceof Error,
  );

  const cancelable = await createPayrollRun(prisma, ownerA, {
    payPeriodStart: new Date(weekStart.getTime() + 28 * 24 * 60 * 60 * 1000),
    payPeriodEnd: new Date(weekStart.getTime() + 35 * 24 * 60 * 60 * 1000),
  });
  const cancelled = await cancelPayrollRun(prisma, ownerA, { payrollRunId: cancelable.id, reason: "Wrong period" });
  check("Cancel keeps the historical record", cancelled.status === "CANCELLED");
  const cancelEvent = await prisma.payrollRunEvent.findFirst({
    where: { payrollRunId: cancelable.id, action: "CANCEL" },
  });
  check("Cancel is audited", Boolean(cancelEvent?.reason === "Wrong period"));

  const scopedRuns = await prisma.payrollRun.findMany({ where: { businessId: businessA.id } });
  check("Scoped A query never returns B payroll runs", scopedRuns.every((run) => run.businessId === businessA.id));

  console.log(
    failures === 0 ? "\nAll Payroll checks passed." : `\n${failures} Payroll check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);

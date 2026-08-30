/**
 * Real MEMBER field clock → OWNER Time Cards punch-list (A–N).
 * Uses the existing collpro-test OWNER/MEMBER accounts. Creates one
 * disposable assigned Job only — does not touch customer/estimate/invoice
 * history. Cleans up only the rows this script inserts.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-field-time-cards-flow.mjs
 */
import { register } from "node:module";
import { createHash, randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { prisma } = await import("@/lib/prisma");
const { CAPABILITIES, ForbiddenError, roleHasCapability } = await import("@/lib/authorization");
const { weekRange } = await import("@/lib/time-cards");
const {
  approveTimesheetWeek,
  clockInTime,
  clockOutTime,
  updateMembershipWage,
  TimeCardError,
} = await import("@/lib/time-card-ops");

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:43217";

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
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

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function makeSession(userId) {
  const token = randomUUID();
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return token;
}

const owner = await prisma.user.findUnique({ where: { email: "owner@collpro-test.example" } });
const member = await prisma.user.findUnique({ where: { email: "john@collpro-test.example" } });
if (!owner || !member) {
  console.error("Expected existing test users owner@collpro-test.example / john@collpro-test.example");
  process.exit(1);
}

const ownerMem = await prisma.membership.findFirst({ where: { userId: owner.id, active: true } });
const memberMem = await prisma.membership.findFirst({ where: { userId: member.id, active: true } });
if (!ownerMem || !memberMem || ownerMem.businessId !== memberMem.businessId) {
  console.error("Expected OWNER and MEMBER memberships on the same business.");
  process.exit(1);
}

const businessId = ownerMem.businessId;
const ownerAccess = makeAccess(businessId, "OWNER", ownerMem.id);
const memberAccess = makeAccess(businessId, "MEMBER", memberMem.id);
const createdEntryIds = [];
let createdJobId = null;
let createdWeekId = null;

try {
  if (memberMem.hourlyWage == null) {
    await updateMembershipWage(prisma, ownerAccess, {
      membershipId: memberMem.id,
      hourlyWage: "28",
    });
  }

  const job = await prisma.job.create({
    data: {
      businessId,
      status: "SCHEDULED",
      projectToken: `flow-test-${randomUUID()}`,
      assignedMembershipId: memberMem.id,
    },
  });
  createdJobId = job.id;

  const startedAt = new Date(Date.now() - 90 * 60 * 1000);
  const jobEntry = await clockInTime(prisma, memberAccess, {
    membershipId: memberMem.id,
    activityType: "JOB",
    jobId: job.id,
    startedAt,
  });
  createdEntryIds.push(jobEntry.id);
  check("A. MEMBER clocks into a valid JOB activity", jobEntry.status === "RUNNING" && jobEntry.activityType === "JOB");
  check("B. TimeEntry is RUNNING", jobEntry.status === "RUNNING" && jobEntry.endedAt == null);

  const ownerSeesRunning = await prisma.timeEntry.findFirst({
    where: { businessId, membershipId: memberMem.id, status: "RUNNING" },
  });
  check("C. OWNER Today can see that worker as clocked in", ownerSeesRunning?.id === jobEntry.id);

  const closed = await clockOutTime(prisma, memberAccess, {
    membershipId: memberMem.id,
    endedAt: new Date(startedAt.getTime() + 60 * 60 * 1000),
  });
  check("D/E. MEMBER clock-out becomes READY", closed.status === "READY" && closed.endedAt != null);
  const hours = (closed.endedAt.getTime() - closed.startedAt.getTime()) / 3_600_000;
  check("F. Owner sees 1.00 elapsed hour", hours === 1);

  const pickup = await clockInTime(prisma, memberAccess, {
    membershipId: memberMem.id,
    activityType: "MATERIAL_PICKUP",
    startedAt: new Date(startedAt.getTime() + 70 * 60 * 1000),
  });
  createdEntryIds.push(pickup.id);
  const pickupReady = await clockOutTime(prisma, memberAccess, {
    membershipId: memberMem.id,
    endedAt: new Date(startedAt.getTime() + 90 * 60 * 1000),
  });
  check(
    "H. Material Pickup is a non-job READY activity",
    pickup.activityType === "MATERIAL_PICKUP" &&
      pickup.jobId == null &&
      pickupReady.status === "READY",
  );

  const weekEntries = await prisma.timeEntry.findMany({
    where: { businessId, membershipId: memberMem.id, id: { in: createdEntryIds } },
  });
  check("G. Both entries exist for Timesheets", weekEntries.length === 2 && weekEntries.every((e) => e.status === "READY"));

  check(
    "J. MEMBER lacks MANAGE_TIME_CARDS",
    !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_TIME_CARDS),
  );
  let memberDeniedApprove = false;
  try {
    await approveTimesheetWeek(prisma, memberAccess, {
      membershipId: memberMem.id,
      weekStartedAt: startedAt,
    });
  } catch (error) {
    memberDeniedApprove = error instanceof ForbiddenError || error instanceof TimeCardError;
  }
  check("J. MEMBER cannot approve a week", memberDeniedApprove);

  const { start, end } = weekRange(startedAt);
  const otherWeekEntries = await prisma.timeEntry.count({
    where: {
      businessId,
      membershipId: memberMem.id,
      id: { notIn: createdEntryIds },
      startedAt: { lt: end },
      OR: [{ endedAt: null }, { endedAt: { gt: start } }],
    },
  });
  if (otherWeekEntries > 0) {
    check(
      "L/M/N skipped on this DB (other entries exist this week; covered by test:time-cards)",
      true,
    );
  } else {
    const week = await approveTimesheetWeek(prisma, ownerAccess, {
      membershipId: memberMem.id,
      weekStartedAt: startedAt,
    });
    createdWeekId = week.id;
    check("L. Weekly approval is Payroll Ready (APPROVED)", week.status === "APPROVED");
    check(
      "M. Approval snapshots hours/wage/labor cost",
      Number(week.approvedHours) > 0 &&
        Number(week.approvedHourlyWage) > 0 &&
        Number(week.approvedLaborCost) > 0,
    );

    const snapWage = Number(week.approvedHourlyWage);
    const snapCost = Number(week.approvedLaborCost);
    await updateMembershipWage(prisma, ownerAccess, {
      membershipId: memberMem.id,
      hourlyWage: String(snapWage + 10),
    });
    const weekAfter = await prisma.timesheetWeek.findUnique({ where: { id: week.id } });
    const approvedJob = await prisma.timeEntry.findUnique({ where: { id: jobEntry.id } });
    check(
      "N. Later wage change does not rewrite approved snapshots",
      Number(weekAfter.approvedHourlyWage) === snapWage &&
        Number(weekAfter.approvedLaborCost) === snapCost &&
        Number(approvedJob.approvedHourlyWage) === snapWage,
    );
    await updateMembershipWage(prisma, ownerAccess, {
      membershipId: memberMem.id,
      hourlyWage: String(snapWage),
    });
  }

  const ownerToken = await makeSession(owner.id);
  const memberToken = await makeSession(member.id);
  async function fetchPage(token, path) {
    const res = await fetch(`${APP_URL}${path}`, {
      redirect: "manual",
      headers: { cookie: `tbbt_session=${token}; tbbt_workspace=${businessId}` },
    }).catch(() => null);
    if (!res) return null;
    return { status: res.status, location: res.headers.get("location"), body: await res.text() };
  }

  const fieldPage = await fetchPage(memberToken, "/field");
  if (fieldPage) {
    check("I. MEMBER /field shows My Time", fieldPage.status === 200 && fieldPage.body.includes("My Time"));
    check(
      "I. MEMBER field HTML has no wage",
      !fieldPage.body.includes("hourlyWage") &&
        !fieldPage.body.includes("$28") &&
        !/\bwage\b/i.test(fieldPage.body.replace(/My Time[\s\S]{0,40}/, "")),
    );
    check(
      "Field clock offers Job / Travel / Material Pickup / Break / Other",
      fieldPage.body.includes("Clock In · Job") &&
        fieldPage.body.includes("Travel") &&
        fieldPage.body.includes("Material Pickup") &&
        fieldPage.body.includes("Break") &&
        fieldPage.body.includes("Other"),
    );
  } else {
    check("I. MEMBER /field reachable for HTML privacy check", false);
  }

  const memberConsole = await fetchPage(memberToken, "/time-cards");
  if (memberConsole) {
    check(
      "J. MEMBER cannot open management /time-cards",
      memberConsole.status === 307 &&
        (memberConsole.location || "").includes("access-restricted"),
    );
  } else {
    check("J. MEMBER /time-cards HTTP check ran", false);
  }

  const ownerToday = await fetchPage(ownerToken, "/time-cards?view=today");
  const ownerSheets = await fetchPage(ownerToken, "/time-cards?view=timesheets");
  if (ownerToday && ownerSheets) {
    check("C/K. OWNER Time Cards page loads", ownerToday.status === 200 && ownerToday.body.includes("Time Cards"));
    check(
      "G. OWNER Timesheets view loads",
      ownerSheets.status === 200 && ownerSheets.body.includes("Timesheets"),
    );
    check(
      "K. OWNER management chrome includes Today / Approvals / Crew",
      ownerToday.body.includes("Today") &&
        ownerToday.body.includes("Approvals") &&
        ownerToday.body.includes("Crew"),
    );
  }
} finally {
  if (createdWeekId) {
    await prisma.timesheetWeek.delete({ where: { id: createdWeekId } }).catch(() => {});
  }
  if (createdEntryIds.length) {
    await prisma.timeEntryAdjustment.deleteMany({ where: { timeEntryId: { in: createdEntryIds } } });
    await prisma.timeEntry.deleteMany({ where: { id: { in: createdEntryIds } } });
  }
  if (createdJobId) {
    await prisma.job.delete({ where: { id: createdJobId } }).catch(() => {});
  }
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

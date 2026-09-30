/**
 * Founder Handyman scheduling-to-field-day regressions.
 *
 * Proves persisted first/later arrival windows stay aligned with the
 * existing worker-day lane policy after scheduleJob + assignJobMember,
 * and that known material pickup occupies time before the appointment
 * in the same availability engine scheduleJob already uses.
 *
 * Reuses canonical scheduleJob / assignJobMember. Does not edit the
 * Founder Handyman launch verifier or invent new scheduling policy.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-handyman-schedule-field-day.mjs
 */
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

register(new URL("./estimate-options-test-loader.mjs", import.meta.url), import.meta.url);

process.env.TZ = process.env.TZ || "America/New_York";
process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER =
  process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER || "fake";

let passed = 0;
let failed = 0;

function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
  }
}

function form(fields) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) data.set(key, String(value));
  }
  return data;
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

console.log("\nSTATIC — canonical schedule/assign persist first/later windows");
const jobActionSrc = readRepo("src/app/actions/job.ts");
const workforceSrc = readRepo("src/lib/workforce.ts");
check(
  "scheduleJob still recomputes first/later from appointmentPositionOnDay",
  jobActionSrc.includes("appointmentPositionOnDay") &&
    jobActionSrc.includes("arrivalWindowMinutesForMode") &&
    jobActionSrc.includes("persistLaneArrivalWindows"),
);
check(
  "assignJobMember syncs persisted arrival windows after the assignment write",
  jobActionSrc.includes("syncAssignedJobArrivalWindows") &&
    workforceSrc.includes("export function laneArrivalWindowUpdates"),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "handyman-schedule-field-day disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_handyman_schedule_field",
  setProcessEnv: true,
});

try {
  const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
  const { ForbiddenError } = await import("@/lib/authorization");
  const { scheduleJob, assignJobMember } = await import("@/app/actions/job");
  const { DEFAULT_SCHEDULING_POLICY } = await import("@/lib/workforce");
  const { portalAppointmentWhenLabel } = await import("@/lib/portal-project-home");
  const { evaluateProposedSchedule } = await import("@/lib/availability");
  const { zonedCivilToUtc } = await import("@/lib/business-timezone");
  const { setTestAccess } = await import("./estimate-options-test-access.mjs");
  const { prisma } = await import("@/lib/prisma");

  function makeAccess(business, role, membership) {
    return {
      businessId: business.id,
      workspace: {
        role,
        membership: { id: membership.id },
        user: { id: membership.userId },
        business: {
          id: business.id,
          name: business.name,
          slug: business.slug,
          tradeCode: business.tradeCode,
          timezone: business.timezone,
        },
      },
      scope: businessScope(business.id),
      assertOwned(record) {
        return assertBusinessRecord(record, business.id);
      },
      assertAttachable(record) {
        return assertBusinessRecord(record, business.id);
      },
    };
  }

  async function scheduleWithAck(jobId, fields) {
    let result = await scheduleJob({}, form({ jobId, ...fields }));
    if (result?.warning && result.conflictAck) {
      result = await scheduleJob(
        {},
        form({ jobId, ...fields, confirmOverlapAck: result.conflictAck }),
      );
    }
    return result;
  }

  async function createJob(business, customer, extras = {}) {
    return prisma.job.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        projectToken: randomUUID(),
        status: "UNSCHEDULED",
        ...extras,
      },
    });
  }

  const suffix = randomUUID().slice(0, 8);
  const NY = "America/New_York";
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Schedule Field",
      slug: `alpha-sched-field-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Schedule Field",
      slug: `beta-sched-field-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
    },
  });

  const ownerUser = await prisma.user.create({
    data: { name: "Owner A", email: `owner-a-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Member A", email: `member-a-${suffix}@example.com`, passwordHash: "x" },
  });
  const otherMemberUser = await prisma.user.create({
    data: { name: "Member A2", email: `member-a2-${suffix}@example.com`, passwordHash: "x" },
  });
  const inactiveUser = await prisma.user.create({
    data: { name: "Inactive A", email: `inactive-a-${suffix}@example.com`, passwordHash: "x" },
  });
  const betaOwnerUser = await prisma.user.create({
    data: { name: "Owner B", email: `owner-b-${suffix}@example.com`, passwordHash: "x" },
  });
  const betaMemberUser = await prisma.user.create({
    data: { name: "Member B", email: `member-b-${suffix}@example.com`, passwordHash: "x" },
  });

  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const otherMemberMem = await prisma.membership.create({
    data: { userId: otherMemberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const inactiveMem = await prisma.membership.create({
    data: {
      userId: inactiveUser.id,
      businessId: businessA.id,
      role: "MEMBER",
      active: false,
    },
  });
  const betaOwnerMem = await prisma.membership.create({
    data: { userId: betaOwnerUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const betaMemberMem = await prisma.membership.create({
    data: { userId: betaMemberUser.id, businessId: businessB.id, role: "MEMBER" },
  });

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada First" },
  });
  const customerA2 = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Later Lane" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Cust" },
  });

  const ownerA = makeAccess(businessA, "OWNER", ownerMem);
  const memberA = makeAccess(businessA, "MEMBER", memberMem);
  const ownerB = makeAccess(businessB, "OWNER", betaOwnerMem);

  console.log("\nBEHAVIOR — approved-job scheduling, first/later windows, isolation");

  const firstJob = await createJob(businessA, customerA);
  const laterJob = await createJob(businessA, customerA2);
  const otherWorkerJob = await createJob(businessA, customerA);
  const betaJob = await createJob(businessB, customerB);

  setTestAccess(ownerA);
  const firstScheduled = await scheduleWithAck(firstJob.id, {
    date: "2027-06-15",
    time: "08:00",
    durationPreset: "60",
  });
  check("First job schedules without error", !firstScheduled?.error);
  const assignedFirst = await assignJobMember(
    {},
    form({ jobId: firstJob.id, membershipId: memberMem.id }),
  );
  check("First job assigns to the MEMBER", !assignedFirst?.error);

  const laterScheduled = await scheduleWithAck(laterJob.id, {
    date: "2027-06-15",
    time: "11:00",
    durationPreset: "60",
  });
  check("Later unassigned job schedules without error", !laterScheduled?.error);
  const laterBeforeAssign = await prisma.job.findFirst({
    where: { id: laterJob.id, businessId: businessA.id },
    select: { arrivalWindowMinutes: true, assignedMembershipId: true, status: true },
  });
  check(
    "Founder schedule-then-assign path starts as exact while still unassigned",
    laterBeforeAssign?.status === "SCHEDULED" &&
      laterBeforeAssign.assignedMembershipId == null &&
      laterBeforeAssign.arrivalWindowMinutes == null,
  );

  const assignedLater = await assignJobMember(
    {},
    form({ jobId: laterJob.id, membershipId: memberMem.id }),
  );
  check("Later job assigns to the same MEMBER", !assignedLater?.error);

  const [firstAfter, laterAfter] = await Promise.all([
    prisma.job.findFirst({
      where: { id: firstJob.id, businessId: businessA.id },
    }),
    prisma.job.findFirst({
      where: { id: laterJob.id, businessId: businessA.id },
    }),
  ]);
  check(
    "First appointment on the worker lane stays exact after the later assignment",
    firstAfter?.assignedMembershipId === memberMem.id &&
      firstAfter?.arrivalWindowMinutes == null,
  );
  check(
    "Later appointment persists the default arrival window after assignJobMember",
    laterAfter?.assignedMembershipId === memberMem.id &&
      laterAfter?.arrivalWindowMinutes === DEFAULT_SCHEDULING_POLICY.defaultArrivalWindowMinutes,
  );

  const firstLabel = portalAppointmentWhenLabel(firstAfter?.scheduledAt, firstAfter?.arrivalWindowMinutes, NY);
  const laterLabel = portalAppointmentWhenLabel(laterAfter?.scheduledAt, laterAfter?.arrivalWindowMinutes, NY);
  check(
    "Portal/field exact vs window labels follow the persisted first/later minutes",
    firstLabel.kind === "exact" &&
      firstLabel.label.includes("8:00 AM") &&
      laterLabel.kind === "window" &&
      laterLabel.label.includes("11:00 AM") &&
      laterLabel.label.includes("1:00 PM"),
  );

  const otherScheduled = await scheduleWithAck(otherWorkerJob.id, {
    date: "2027-06-15",
    time: "11:00",
    durationPreset: "60",
  });
  check("Second worker job schedules", !otherScheduled?.error);
  const assignedOther = await assignJobMember(
    {},
    form({ jobId: otherWorkerJob.id, membershipId: otherMemberMem.id }),
  );
  check("Second worker receives their own first appointment", !assignedOther?.error);
  const otherAfter = await prisma.job.findFirst({
    where: { id: otherWorkerJob.id, businessId: businessA.id },
    select: { arrivalWindowMinutes: true, assignedMembershipId: true },
  });
  check(
    "A second worker's first job that day stays exact",
    otherAfter?.assignedMembershipId === otherMemberMem.id &&
      otherAfter?.arrivalWindowMinutes == null,
  );

  const inserted = await createJob(businessA, customerA2);
  const insertedScheduled = await scheduleWithAck(inserted.id, {
    date: "2027-06-15",
    time: "07:00",
    durationPreset: "60",
  });
  check("Earlier job schedules", !insertedScheduled?.error);
  const assignedInserted = await assignJobMember(
    {},
    form({ jobId: inserted.id, membershipId: memberMem.id }),
  );
  check("Earlier job assigns to the same MEMBER", !assignedInserted?.error);
  const formerFirst = await prisma.job.findFirst({
    where: { id: firstJob.id, businessId: businessA.id },
    select: { arrivalWindowMinutes: true, scheduledAt: true },
  });
  const newFirst = await prisma.job.findFirst({
    where: { id: inserted.id, businessId: businessA.id },
    select: { arrivalWindowMinutes: true },
  });
  check(
    "Inserting an earlier appointment persists a window on the former first job",
    newFirst?.arrivalWindowMinutes == null &&
      formerFirst?.arrivalWindowMinutes === DEFAULT_SCHEDULING_POLICY.defaultArrivalWindowMinutes,
  );

  setTestAccess(ownerB);
  const betaScheduled = await scheduleWithAck(betaJob.id, {
    date: "2027-06-15",
    time: "11:00",
    durationPreset: "60",
  });
  check("Tenant B job schedules", !betaScheduled?.error);
  const betaAssigned = await assignJobMember(
    {},
    form({ jobId: betaJob.id, membershipId: betaMemberMem.id }),
  );
  check("Tenant B assignment stays on tenant B", !betaAssigned?.error);
  const betaAfter = await prisma.job.findFirst({
    where: { id: betaJob.id, businessId: businessB.id },
    select: { arrivalWindowMinutes: true, assignedMembershipId: true },
  });
  const laterStill = await prisma.job.findFirst({
    where: { id: laterJob.id, businessId: businessA.id },
    select: { arrivalWindowMinutes: true, assignedMembershipId: true },
  });
  check(
    "Tenant B first job stays exact and does not rewrite tenant A windows",
    betaAfter?.assignedMembershipId === betaMemberMem.id &&
      betaAfter?.arrivalWindowMinutes == null &&
      laterStill?.assignedMembershipId === memberMem.id &&
      laterStill?.arrivalWindowMinutes === DEFAULT_SCHEDULING_POLICY.defaultArrivalWindowMinutes,
  );

  setTestAccess(memberA);
  let memberScheduleError = null;
  try {
    await scheduleJob(
      {},
      form({ jobId: laterJob.id, date: "2027-06-16", time: "09:00", durationPreset: "60" }),
    );
  } catch (error) {
    memberScheduleError = error;
  }
  check(
    "Assigned MEMBER cannot scheduleJob",
    memberScheduleError instanceof ForbiddenError,
  );
  let memberAssignError = null;
  try {
    await assignJobMember(
      {},
      form({ jobId: laterJob.id, membershipId: otherMemberMem.id }),
    );
  } catch (error) {
    memberAssignError = error;
  }
  check(
    "Assigned MEMBER cannot assignJobMember",
    memberAssignError instanceof ForbiddenError,
  );

  setTestAccess(ownerA);
  const inactiveAssign = await assignJobMember(
    {},
    form({ jobId: laterJob.id, membershipId: inactiveMem.id }),
  );
  check("Inactive membership cannot be assigned", Boolean(inactiveAssign?.error));
  const laterUnchanged = await prisma.job.findFirst({
    where: { id: laterJob.id, businessId: businessA.id },
    select: { assignedMembershipId: true },
  });
  check(
    "Failed inactive assignment leaves the current worker in place",
    laterUnchanged?.assignedMembershipId === memberMem.id,
  );

  console.log("\nBEHAVIOR — known pickup occupies time before the appointment");
  const pickupExistingStart = zonedCivilToUtc(2027, 6, 16, 10, 0, 0, NY);
  const pickupOverlap = evaluateProposedSchedule({
    start: zonedCivilToUtc(2027, 6, 16, 8, 0, 0, NY),
    durationMinutes: 45,
    settings: {
      workingWeekdays: [1, 2, 3, 4, 5],
      workStartMinutes: 480,
      workEndMinutes: 1020,
      schedulingBufferMinutes: 0,
      unavailableDates: [],
    },
    existing: [
      {
        id: "known-pickup",
        scheduledAt: pickupExistingStart,
        scheduledDurationMinutes: 60,
        pickupDurationMinutes: 90,
        customerName: "Pickup",
      },
    ],
    timeZone: NY,
  });
  check(
    "Availability overlap includes known pickup before scheduledAt",
    Boolean(pickupOverlap.overlap),
  );

  await prisma.businessSettings.upsert({
    where: { businessId: businessA.id },
    create: { businessId: businessA.id, schedulingBufferMinutes: 0 },
    update: { schedulingBufferMinutes: 0 },
  });
  const pickupJob = await createJob(businessA, customerA);
  const occupiedPickup = await createJob(businessA, customerA2);
  const occupiedScheduled = await scheduleWithAck(occupiedPickup.id, {
    date: "2027-06-16",
    time: "10:00",
    durationPreset: "60",
    pickupDurationMinutes: "90",
  });
  check("Occupied pickup job schedules", !occupiedScheduled?.error);
  const occupiedRow = await prisma.job.findFirst({
    where: { id: occupiedPickup.id, businessId: businessA.id },
    select: { pickupDurationMinutes: true },
  });
  check(
    "scheduleJob persisted the known 90-minute pickup on the occupied job",
    occupiedRow?.pickupDurationMinutes === 90,
  );
  const colliding = await scheduleJob(
    {},
    form({
      jobId: pickupJob.id,
      date: "2027-06-16",
      time: "08:00",
      durationPreset: "60",
    }),
  );
  check(
    "scheduleJob warns when a later job's known pickup overlaps the proposed slot",
    Boolean(colliding?.warning) && Boolean(colliding?.conflictAck),
  );

  if (failed > 0) {
    throw new Error(`${failed} handyman schedule/field-day check(s) failed`);
  }
} finally {
  await session.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}

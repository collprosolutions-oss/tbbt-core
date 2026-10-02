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
const assignOpsSrc = readRepo("src/lib/job-assignment-ops.ts");
check(
  "assignJobMember syncs persisted arrival windows after the assignment write",
  jobActionSrc.includes("writeAssignedMembershipAndLaneWindows") &&
    assignOpsSrc.includes("syncAssignedJobArrivalWindows") &&
    assignOpsSrc.includes("writeAssignedMembershipAndLaneWindows") &&
    assignOpsSrc.includes("lockBusinessScheduleReservation") &&
    jobActionSrc.includes("lockBusinessScheduleReservation") &&
    workforceSrc.includes("export function laneArrivalWindowUpdates"),
);
const persistSrc = readRepo("src/lib/workforce-data.ts");
const persistSection = persistSrc.slice(
  persistSrc.indexOf("export type ArrivalWindowLaneRef"),
  persistSrc.indexOf("export async function loadCapacityJobs"),
);
check(
  "persistLaneArrivalWindows locks, re-reads assignment/time, and writes inside one reservation",
  persistSection.includes("lockBusinessScheduleReservation") &&
    persistSection.includes("$transaction") &&
    persistSection.includes("assignedMembershipId: true") &&
    persistSection.includes("scheduledAt: true") &&
    persistSection.includes("touchedJobIds") &&
    persistSection.includes("previousLanes") &&
    persistSection.includes("LANE_WINDOW_JOB_SELECT") &&
    !persistSection.includes("jobs: Array<{"),
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
  const { PrismaClient } = await import("@prisma/client");
  const { scheduleJob, assignJobMember } = await import("@/app/actions/job");
  const { DEFAULT_SCHEDULING_POLICY } = await import("@/lib/workforce");
  const { persistLaneArrivalWindows } = await import("@/lib/workforce-data");
  const { portalAppointmentWhenLabel } = await import("@/lib/portal-project-home");
  const { evaluateProposedSchedule } = await import("@/lib/availability");
  const { zonedCivilToUtc } = await import("@/lib/business-timezone");
  const { changeOwnerDayRouteAppointment } = await import(
    "@/lib/owner-day-route-appointment-ops"
  );
  const { scheduleSnapshotFromJob } = await import("@/lib/owner-day-route/snapshot");
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

  console.log("\nBEHAVIOR — lane persist reservation, rollback, concurrency, and day-route");
  setTestAccess(ownerA);
  const raceFirst = await createJob(businessA, customerA);
  const raceLater = await createJob(businessA, customerA);
  const raceOtherWorker = await createJob(businessA, customerA);
  const raceOtherDay = await createJob(businessA, customerA);
  await scheduleWithAck(raceFirst.id, {
    date: "2027-06-22",
    time: "08:00",
    durationPreset: "60",
  });
  await scheduleWithAck(raceLater.id, {
    date: "2027-06-22",
    time: "11:00",
    durationPreset: "60",
  });
  await scheduleWithAck(raceOtherWorker.id, {
    date: "2027-06-22",
    time: "11:00",
    durationPreset: "60",
  });
  await scheduleWithAck(raceOtherDay.id, {
    date: "2027-06-23",
    time: "08:00",
    durationPreset: "60",
  });
  await assignJobMember({}, form({ jobId: raceFirst.id, membershipId: memberMem.id }));
  await assignJobMember({}, form({ jobId: raceLater.id, membershipId: memberMem.id }));
  await assignJobMember({}, form({ jobId: raceOtherWorker.id, membershipId: otherMemberMem.id }));
  await assignJobMember({}, form({ jobId: raceOtherDay.id, membershipId: memberMem.id }));

  await prisma.job.update({
    where: { id: raceOtherWorker.id },
    data: { arrivalWindowMinutes: DEFAULT_SCHEDULING_POLICY.defaultArrivalWindowMinutes },
  });
  await prisma.job.update({
    where: { id: raceOtherDay.id },
    data: { arrivalWindowMinutes: DEFAULT_SCHEDULING_POLICY.defaultArrivalWindowMinutes },
  });

  const laterBeforeStale = await prisma.job.findFirst({
    where: { id: raceLater.id, businessId: businessA.id },
    select: { arrivalWindowMinutes: true, scheduledAt: true, assignedMembershipId: true },
  });
  check(
    "Control: later worker-day job persisted a 120-minute window",
    laterBeforeStale?.arrivalWindowMinutes === DEFAULT_SCHEDULING_POLICY.defaultArrivalWindowMinutes,
  );
  const staleAttempt = await persistLaneArrivalWindows(prisma, {
    businessId: businessA.id,
    timeZone: NY,
    policy: DEFAULT_SCHEDULING_POLICY,
    touchedJobIds: [raceLater.id],
    previousLanes: [
      {
        assignedMembershipId: null,
        scheduledAt: laterBeforeStale?.scheduledAt ?? null,
      },
    ],
  });
  const laterAfterStale = await prisma.job.findFirst({
    where: { id: raceLater.id, businessId: businessA.id },
    select: { arrivalWindowMinutes: true, assignedMembershipId: true },
  });
  check(
    "Stale caller snapshot cannot overwrite a correct 120-minute later window back to null",
    laterAfterStale?.assignedMembershipId === memberMem.id &&
      laterAfterStale?.arrivalWindowMinutes === DEFAULT_SCHEDULING_POLICY.defaultArrivalWindowMinutes &&
      !staleAttempt.some((row) => row.id === raceLater.id && row.arrivalWindowMinutes == null),
  );

  const [otherWorkerPoisoned, otherDayPoisoned] = await Promise.all([
    prisma.job.findFirst({
      where: { id: raceOtherWorker.id, businessId: businessA.id },
      select: { arrivalWindowMinutes: true },
    }),
    prisma.job.findFirst({
      where: { id: raceOtherDay.id, businessId: businessA.id },
      select: { arrivalWindowMinutes: true },
    }),
  ]);
  check(
    "Unrelated worker/day lanes are not rewritten by a persist of another lane",
    otherWorkerPoisoned?.arrivalWindowMinutes ===
      DEFAULT_SCHEDULING_POLICY.defaultArrivalWindowMinutes &&
      otherDayPoisoned?.arrivalWindowMinutes ===
        DEFAULT_SCHEDULING_POLICY.defaultArrivalWindowMinutes,
  );

  await prisma.job.update({
    where: { id: raceFirst.id },
    data: { arrivalWindowMinutes: DEFAULT_SCHEDULING_POLICY.defaultArrivalWindowMinutes },
  });
  await prisma.job.update({
    where: { id: raceLater.id },
    data: { arrivalWindowMinutes: null },
  });
  let injectedUpdates = 0;
  const failing = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL }).$extends({
    query: {
      job: {
        async updateMany({ args, query }) {
          const result = await query(args);
          injectedUpdates += 1;
          if (injectedUpdates >= 2) {
            throw new Error("injected lane update failure");
          }
          return result;
        },
      },
    },
  });
  let injectedError = null;
  try {
    await persistLaneArrivalWindows(failing, {
      businessId: businessA.id,
      timeZone: NY,
      policy: DEFAULT_SCHEDULING_POLICY,
      touchedJobIds: [raceFirst.id, raceLater.id],
      previousLanes: [
        {
          assignedMembershipId: memberMem.id,
          scheduledAt: laterBeforeStale?.scheduledAt ?? null,
        },
      ],
    });
  } catch (error) {
    injectedError = error;
  }
  await failing.$disconnect();
  const [firstAfterInject, laterAfterInject] = await Promise.all([
    prisma.job.findFirst({
      where: { id: raceFirst.id, businessId: businessA.id },
      select: { arrivalWindowMinutes: true },
    }),
    prisma.job.findFirst({
      where: { id: raceLater.id, businessId: businessA.id },
      select: { arrivalWindowMinutes: true },
    }),
  ]);
  check(
    "Injected failure during multiple lane updates rolls the entire update back",
    Boolean(injectedError) &&
      /injected lane update failure/.test(String(injectedError?.message ?? injectedError)) &&
      injectedUpdates >= 2 &&
      firstAfterInject?.arrivalWindowMinutes ===
        DEFAULT_SCHEDULING_POLICY.defaultArrivalWindowMinutes &&
      laterAfterInject?.arrivalWindowMinutes == null,
  );

  await prisma.job.update({
    where: { id: raceFirst.id },
    data: { arrivalWindowMinutes: null },
  });
  await prisma.job.update({
    where: { id: raceLater.id },
    data: { arrivalWindowMinutes: DEFAULT_SCHEDULING_POLICY.defaultArrivalWindowMinutes },
  });

  const concFirst = await createJob(businessA, customerA);
  const concLater = await createJob(businessA, customerA);
  await scheduleWithAck(concFirst.id, {
    date: "2027-06-24",
    time: "08:00",
    durationPreset: "60",
  });
  await scheduleWithAck(concLater.id, {
    date: "2027-06-24",
    time: "11:00",
    durationPreset: "60",
  });
  const [concAssignFirst, concAssignLater] = await Promise.all([
    assignJobMember({}, form({ jobId: concFirst.id, membershipId: memberMem.id })),
    assignJobMember({}, form({ jobId: concLater.id, membershipId: memberMem.id })),
  ]);
  const [concFirstRow, concLaterRow] = await Promise.all([
    prisma.job.findFirst({
      where: { id: concFirst.id, businessId: businessA.id },
    }),
    prisma.job.findFirst({
      where: { id: concLater.id, businessId: businessA.id },
    }),
  ]);
  check(
    "Concurrent assign operations serialize and leave first exact / later windowed",
    !concAssignFirst?.error &&
      !concAssignLater?.error &&
      concFirstRow?.assignedMembershipId === memberMem.id &&
      concLaterRow?.assignedMembershipId === memberMem.id &&
      concFirstRow?.arrivalWindowMinutes == null &&
      concLaterRow?.arrivalWindowMinutes ===
        DEFAULT_SCHEDULING_POLICY.defaultArrivalWindowMinutes,
  );

  const routeFirst = await createJob(businessA, customerA);
  const routeLater = await createJob(businessA, customerA);
  await scheduleWithAck(routeFirst.id, {
    date: "2027-06-25",
    time: "10:00",
    durationPreset: "60",
  });
  await assignJobMember({}, form({ jobId: routeFirst.id, membershipId: memberMem.id }));
  await scheduleWithAck(routeLater.id, {
    date: "2027-06-25",
    time: "14:00",
    durationPreset: "60",
  });
  await assignJobMember({}, form({ jobId: routeLater.id, membershipId: memberMem.id }));
  const routeLaterRow = await prisma.job.findFirst({
    where: { id: routeLater.id, businessId: businessA.id },
  });
  const routeChanged = await changeOwnerDayRouteAppointment(prisma, ownerA, {
    jobId: routeLater.id,
    date: "2027-06-25",
    time: "08:00",
    snapshot: scheduleSnapshotFromJob(routeLaterRow),
  });
  const [routeMoved, routeFormerFirst] = await Promise.all([
    prisma.job.findFirst({
      where: { id: routeLater.id, businessId: businessA.id },
      select: { arrivalWindowMinutes: true, scheduledAt: true },
    }),
    prisma.job.findFirst({
      where: { id: routeFirst.id, businessId: businessA.id },
      select: { arrivalWindowMinutes: true },
    }),
  ]);
  check(
    "Day-route reorder of an earlier stop persists a window on the former first job",
    routeChanged.arrivalWindowMinutes == null &&
      routeMoved?.arrivalWindowMinutes == null &&
      routeFormerFirst?.arrivalWindowMinutes ===
        DEFAULT_SCHEDULING_POLICY.defaultArrivalWindowMinutes,
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

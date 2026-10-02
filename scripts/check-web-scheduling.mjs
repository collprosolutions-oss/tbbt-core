/**
 * Web scheduling from an approved job through assignment, day-route,
 * reschedule, pickup time, conflict acknowledgement, and reassignment.
 *
 * Uses the existing scheduleJob / assignJobMember /
 * changeOwnerDayRouteAppointment operations on a dedicated disposable
 * database. Does not invent a second scheduling workflow, send a
 * customer message, or deploy.
 *
 * Run with:
 *   npm run test:web-scheduling
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

function sourceOfExportedFunction(src, name) {
  const match = src.match(new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}\\n`));
  return match?.[0] ?? "";
}

console.log("\nSTATIC — existing workflow, route refresh, terminal refusals");
const jobActionSrc = readRepo("src/app/actions/job.ts");
const assignOpsSrc = readRepo("src/lib/job-assignment-ops.ts");
const dayRouteOpsSrc = readRepo("src/lib/owner-day-route-appointment-ops.ts");
const lifecycleSrc = readRepo("src/lib/job-lifecycle.ts");
const jobPageSrc = readRepo("src/app/(app)/jobs/[jobId]/page.tsx");
const jobsWorkspaceSrc = readRepo("src/components/jobs/jobs-workspace.tsx");
const dayRouteViewSrc = readRepo("src/components/today/owner-day-route.tsx");
const scheduleJobSrc = sourceOfExportedFunction(jobActionSrc, "scheduleJob");
const assignJobSrc = sourceOfExportedFunction(jobActionSrc, "assignJobMember");

check(
  "Verifier stays on scheduleJob / assignJobMember / day-route appointment",
  jobActionSrc.includes("evaluateOwnedScheduleProposal") &&
    jobActionSrc.includes("lockBusinessScheduleReservation") &&
    assignOpsSrc.includes("jobAssignmentRefusalMessage") &&
    dayRouteOpsSrc.includes("pickupMinutesForJob") &&
    !jobActionSrc.includes("createCalendarEvent") &&
    !dayRouteOpsSrc.includes("notifyCustomerAppointmentProposed"),
);
check(
  "scheduleJob still evaluates availability and recomputes conflict acknowledgement",
  jobActionSrc.includes("evaluateOwnedScheduleProposal") &&
    jobActionSrc.includes("confirmOverlapAck") &&
    jobActionSrc.includes("shouldAcceptConflictAcknowledgement") &&
    jobActionSrc.includes("conflictAcknowledgement") &&
    jobActionSrc.includes("evaluateProposedSchedule") &&
    jobActionSrc.includes("loadOccupiedJobs") &&
    jobActionSrc.includes("conflictsInvolvingJob"),
);
check(
  "scheduleJob re-evaluates occupancy after the reservation lock",
  scheduleJobSrc.includes("lockBusinessScheduleReservation") &&
    jobActionSrc.includes("evaluateOwnedScheduleProposal(tx,") &&
    jobActionSrc.includes("jobScheduleRefusalMessage") &&
    jobActionSrc.includes('fresh.status === "UNSCHEDULED"'),
);
check(
  "scheduleJob and assignJobMember revalidate the recorded day-route",
  jobActionSrc.includes("OWNER_DAY_ROUTE_PATH") &&
    jobActionSrc.includes('revalidatePath("/today")') &&
    jobActionSrc.includes("revalidateJobSurfaces(job)") &&
    assignJobSrc.includes("revalidateJobSurfaces(job)") &&
    assignJobSrc.includes("jobAssignmentRefusalMessage"),
);
check(
  "Completed and cancelled jobs are refused by schedule, assign, and day-route",
  lifecycleSrc.includes("JOB_CANCELLED_CANNOT_RESCHEDULE_MESSAGE") &&
    lifecycleSrc.includes("JOB_CANCELLED_CANNOT_ASSIGN_MESSAGE") &&
    dayRouteOpsSrc.includes("DAY_ROUTE_APPOINTMENT_CANCELLED_MESSAGE") &&
    dayRouteOpsSrc.includes("afterDayRouteAppointmentRead") &&
    dayRouteOpsSrc.includes("jobScheduleRefusalMessage") &&
    dayRouteOpsSrc.lastIndexOf("afterDayRouteAppointmentRead") <
      dayRouteOpsSrc.lastIndexOf("lockTenantOwnedJob") &&
    dayRouteOpsSrc.lastIndexOf("lockTenantOwnedJob") <
      dayRouteOpsSrc.lastIndexOf("jobScheduleRefusalMessage") &&
    jobPageSrc.includes("Cancelled jobs keep their saved appointment") &&
    jobsWorkspaceSrc.includes("A cancelled job cannot be assigned.") &&
    dayRouteViewSrc.includes('stop.status !== "CANCELLED"'),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "web-scheduling disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_web_scheduling",
  setProcessEnv: true,
});

try {
  const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
  const { createJobFromApprovedEstimate } = await import("@/lib/job-from-estimate");
  const { scheduleJob, assignJobMember } = await import("@/app/actions/job");
  const { jobWriteTestHooks } = await import("@/lib/job-write-test-hooks");
  const { jobAssignmentTestHooks } = await import("@/lib/job-assignment-ops");
  const {
    changeOwnerDayRouteAppointment,
    dayRouteAppointmentErrorMessage,
    dayRouteAppointmentTestHooks,
  } = await import("@/lib/owner-day-route-appointment-ops");
  const {
    DAY_ROUTE_APPOINTMENT_CANCELLED_MESSAGE,
    DAY_ROUTE_APPOINTMENT_COMPLETED_MESSAGE,
  } = await import("@/lib/owner-day-route-appointment");
  const { loadOwnerDayRoute } = await import("@/lib/owner-day-route");
  const { scheduleSnapshotFromJob } = await import("@/lib/owner-day-route/snapshot");
  const { parseScheduleStart } = await import("@/lib/job-schedule");
  const {
    JOB_CANCELLED_CANNOT_ASSIGN_MESSAGE,
    JOB_CANCELLED_CANNOT_RESCHEDULE_MESSAGE,
    JOB_COMPLETED_CANNOT_ASSIGN_MESSAGE,
    JOB_COMPLETED_CANNOT_RESCHEDULE_MESSAGE,
  } = await import("@/lib/job-lifecycle");
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

  async function createApprovedJob(access, business, customer, property, extras = {}) {
    const estimate = await prisma.estimate.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        propertyId: property.id,
        status: "APPROVED",
        publicToken: randomUUID(),
      },
    });
    const converted = await createJobFromApprovedEstimate(prisma, access, estimate.id);
    if (!converted.ok) {
      throw new Error(converted.error);
    }
    if (Object.keys(extras).length > 0) {
      await prisma.job.update({
        where: { id: converted.jobId },
        data: extras,
      });
    }
    return prisma.job.findFirstOrThrow({
      where: { id: converted.jobId, businessId: business.id },
    });
  }

  const suffix = randomUUID().slice(0, 8);
  const NY = "America/New_York";
  const CHI = "America/Chicago";
  const businessNy = await prisma.business.create({
    data: {
      name: "NY Web Schedule",
      slug: `ny-web-sched-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
    },
  });
  const businessChi = await prisma.business.create({
    data: {
      name: "Chicago Web Schedule",
      slug: `chi-web-sched-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: CHI,
    },
  });
  await prisma.businessSettings.create({
    data: {
      businessId: businessNy.id,
      workingWeekdays: "1,2,3,4,5",
      workStartMinutes: 8 * 60,
      workEndMinutes: 17 * 60,
      schedulingBufferMinutes: 0,
    },
  });
  await prisma.businessSettings.create({
    data: {
      businessId: businessChi.id,
      workingWeekdays: "1,2,3,4,5",
      workStartMinutes: 8 * 60,
      workEndMinutes: 17 * 60,
      schedulingBufferMinutes: 0,
    },
  });

  const ownerUser = await prisma.user.create({
    data: { name: "Owner NY", email: `owner-ny-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Member One", email: `member-1-${suffix}@example.com`, passwordHash: "x" },
  });
  const otherMemberUser = await prisma.user.create({
    data: { name: "Member Two", email: `member-2-${suffix}@example.com`, passwordHash: "x" },
  });
  const chiOwnerUser = await prisma.user.create({
    data: { name: "Owner CHI", email: `owner-chi-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessNy.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessNy.id, role: "MEMBER" },
  });
  const otherMemberMem = await prisma.membership.create({
    data: { userId: otherMemberUser.id, businessId: businessNy.id, role: "MEMBER" },
  });
  const chiOwnerMem = await prisma.membership.create({
    data: { userId: chiOwnerUser.id, businessId: businessChi.id, role: "OWNER" },
  });
  const customerNy = await prisma.customer.create({
    data: { businessId: businessNy.id, name: "Ada Home" },
  });
  const customerNy2 = await prisma.customer.create({
    data: { businessId: businessNy.id, name: "Later Stop" },
  });
  const customerChi = await prisma.customer.create({
    data: { businessId: businessChi.id, name: "Chicago House" },
  });
  const propertyNy = await prisma.property.create({
    data: {
      businessId: businessNy.id,
      customerId: customerNy.id,
      addressLine1: "10 Maple St",
      city: "Austin",
      region: "TX",
      postalCode: "78701",
    },
  });
  const propertyNy2 = await prisma.property.create({
    data: {
      businessId: businessNy.id,
      customerId: customerNy2.id,
      addressLine1: "500 Oak Blvd",
      city: "Austin",
      region: "TX",
      postalCode: "78704",
    },
  });
  const propertyChi = await prisma.property.create({
    data: {
      businessId: businessChi.id,
      customerId: customerChi.id,
      addressLine1: "200 Lake Shore",
      city: "Chicago",
      region: "IL",
      postalCode: "60601",
    },
  });

  const ownerNy = makeAccess(businessNy, "OWNER", ownerMem);
  const ownerChi = makeAccess(businessChi, "OWNER", chiOwnerMem);
  setTestAccess(ownerNy);

  console.log("\nBEHAVIOR — approved job through assign, day-route, reschedule, pickup");
  const approvedJob = await createApprovedJob(ownerNy, businessNy, customerNy, propertyNy);
  check(
    "Approved estimate converts to an UNSCHEDULED job",
    approvedJob.status === "UNSCHEDULED" && approvedJob.scheduledAt == null,
  );

  const scheduled = await scheduleJob(
    {},
    form({
      jobId: approvedJob.id,
      date: "2027-06-16",
      time: "10:00",
      durationPreset: "60",
      pickupDurationMinutes: "45",
    }),
  );
  check("scheduleJob persists the approved job appointment and pickup", !scheduled?.error);
  const assigned = await assignJobMember(
    {},
    form({ jobId: approvedJob.id, membershipId: memberMem.id }),
  );
  check("assignJobMember assigns the approved job", !assigned?.error);

  const laterJob = await createApprovedJob(ownerNy, businessNy, customerNy2, propertyNy2);
  const laterScheduled = await scheduleWithAck(laterJob.id, {
    date: "2027-06-16",
    time: "14:00",
    durationPreset: "60",
  });
  check("Second approved job schedules later the same day", !laterScheduled?.error);
  await assignJobMember({}, form({ jobId: laterJob.id, membershipId: memberMem.id }));

  const afterAssign = await loadOwnerDayRoute(prisma, {
    businessId: businessNy.id,
    role: "OWNER",
    date: "2027-06-16",
    timeZone: NY,
  });
  const firstStop = afterAssign.stops.find((stop) => stop.jobId === approvedJob.id);
  const laterStop = afterAssign.stops.find((stop) => stop.jobId === laterJob.id);
  check(
    "Recorded day-route lists both stops in appointment order with pickup",
    Boolean(firstStop && laterStop) &&
      (firstStop?.sequence ?? 0) < (laterStop?.sequence ?? 0) &&
      firstStop?.materialPickup.recorded === true &&
      firstStop?.materialPickup.durationMinutes === 45 &&
      firstStop?.appointmentWindowLabel?.includes("10:00") === true &&
      laterStop?.appointmentWindowLabel?.includes("2:00") === true,
  );

  const laterRow = await prisma.job.findFirstOrThrow({
    where: { id: laterJob.id, businessId: businessNy.id },
  });
  const dayRouteMoved = await changeOwnerDayRouteAppointment(prisma, ownerNy, {
    jobId: laterJob.id,
    date: "2027-06-16",
    time: "08:00",
    snapshot: scheduleSnapshotFromJob(laterRow),
  });
  const refreshedAfterMove = await loadOwnerDayRoute(prisma, {
    businessId: businessNy.id,
    role: "OWNER",
    date: "2027-06-16",
    timeZone: NY,
  });
  const movedStop = refreshedAfterMove.stops.find((stop) => stop.jobId === laterJob.id);
  const formerFirst = refreshedAfterMove.stops.find((stop) => stop.jobId === approvedJob.id);
  check(
    "Day-route reschedule refreshes recorded stop order",
    dayRouteMoved.scheduledAt.toISOString() ===
      parseScheduleStart("2027-06-16", "08:00", NY)?.toISOString() &&
      (movedStop?.sequence ?? 1) < (formerFirst?.sequence ?? 0) &&
      movedStop?.appointmentWindowLabel?.includes("8:00") === true,
  );

  const rescheduled = await scheduleWithAck(approvedJob.id, {
    date: "2027-06-16",
    time: "15:00",
    durationPreset: "60",
    pickupDurationMinutes: "45",
  });
  const refreshedAfterReschedule = await loadOwnerDayRoute(prisma, {
    businessId: businessNy.id,
    role: "OWNER",
    date: "2027-06-16",
    timeZone: NY,
  });
  const rescheduledStop = refreshedAfterReschedule.stops.find(
    (stop) => stop.jobId === approvedJob.id,
  );
  check(
    "scheduleJob reschedule refreshes the recorded route time",
    !rescheduled?.error &&
      rescheduledStop?.appointmentWindowLabel?.includes("3:00") === true &&
      rescheduledStop?.materialPickup.durationMinutes === 45,
  );

  const reassigned = await assignJobMember(
    {},
    form({ jobId: approvedJob.id, membershipId: otherMemberMem.id }),
  );
  const snapshots = await prisma.job.findFirstOrThrow({
    where: { id: approvedJob.id, businessId: businessNy.id },
    select: { assignedMembershipId: true },
  });
  const routeAfterReassign = await loadOwnerDayRoute(prisma, {
    businessId: businessNy.id,
    role: "OWNER",
    date: "2027-06-16",
    timeZone: NY,
  });
  check(
    "Reassignment updates the recorded route snapshot assignee",
    !reassigned?.error &&
      snapshots.assignedMembershipId === otherMemberMem.id &&
      routeAfterReassign.stops.find((stop) => stop.jobId === approvedJob.id)
        ?.scheduleSnapshot.assignedMembershipId === otherMemberMem.id,
  );

  console.log("\nBEHAVIOR — conflict acknowledgement and pickup occupancy");
  const conflictJob = await createApprovedJob(ownerNy, businessNy, customerNy, propertyNy);
  const overlap = await scheduleJob(
    {},
    form({
      jobId: conflictJob.id,
      date: "2027-06-16",
      time: "15:00",
      durationPreset: "60",
    }),
  );
  check(
    "Overlapping appointment returns a warning and server-side conflictAck",
    Boolean(overlap?.warning) && Boolean(overlap?.conflictAck),
  );
  const staleAck = await scheduleJob(
    {},
    form({
      jobId: conflictJob.id,
      date: "2027-06-16",
      time: "15:00",
      durationPreset: "60",
      confirmOverlapAck: "not-the-current-ack",
    }),
  );
  check(
    "A stale conflict acknowledgement is rejected",
    Boolean(staleAck?.warning) && staleAck?.conflictAck === overlap?.conflictAck,
  );
  const accepted = await scheduleJob(
    {},
    form({
      jobId: conflictJob.id,
      date: "2027-06-16",
      time: "15:00",
      durationPreset: "60",
      confirmOverlapAck: overlap.conflictAck,
    }),
  );
  check("Current conflict acknowledgement schedules anyway", !accepted?.error);

  const pickupTarget = await createApprovedJob(ownerNy, businessNy, customerNy2, propertyNy2);
  const pickupOverlap = await scheduleJob(
    {},
    form({
      jobId: pickupTarget.id,
      date: "2027-06-16",
      time: "14:15",
      durationPreset: "60",
    }),
  );
  check(
    "Known pickup on the 3:00 job occupies the 2:15 slot",
    Boolean(pickupOverlap?.warning) && Boolean(pickupOverlap?.conflictAck),
  );

  const dayRoutePickupJob = await createApprovedJob(
    ownerNy,
    businessNy,
    customerNy,
    propertyNy,
  );
  await scheduleWithAck(dayRoutePickupJob.id, {
    date: "2027-06-17",
    time: "14:00",
    durationPreset: "60",
    pickupDurationMinutes: "90",
  });
  const occupiedMorning = await createApprovedJob(
    ownerNy,
    businessNy,
    customerNy2,
    propertyNy2,
  );
  await scheduleWithAck(occupiedMorning.id, {
    date: "2027-06-17",
    time: "10:00",
    durationPreset: "60",
  });
  const pickupRow = await prisma.job.findFirstOrThrow({
    where: { id: dayRoutePickupJob.id, businessId: businessNy.id },
  });
  let dayRoutePickupError = null;
  try {
    await changeOwnerDayRouteAppointment(prisma, ownerNy, {
      jobId: dayRoutePickupJob.id,
      date: "2027-06-17",
      time: "11:00",
      snapshot: scheduleSnapshotFromJob(pickupRow),
    });
  } catch (error) {
    dayRoutePickupError = error;
  }
  check(
    "Day-route change refuses when the job's own pickup overlaps another stop",
    /overlap|pickup|buffer/i.test(
      dayRouteAppointmentErrorMessage(dayRoutePickupError, ""),
    ),
  );

  console.log("\nBEHAVIOR — business timezone and DST boundaries");
  setTestAccess(ownerChi);
  const chiJob = await createApprovedJob(ownerChi, businessChi, customerChi, propertyChi);
  const chiScheduled = await scheduleJob(
    {},
    form({
      jobId: chiJob.id,
      date: "2026-03-09",
      time: "09:00",
      durationPreset: "60",
    }),
  );
  const chiRow = await prisma.job.findFirstOrThrow({
    where: { id: chiJob.id, businessId: businessChi.id },
  });
  const chiInstant = parseScheduleStart("2026-03-09", "09:00", CHI);
  const nyInstant = parseScheduleStart("2026-03-09", "09:00", NY);
  check(
    "Chicago civil 09:00 stores the Chicago instant, not New York",
    !chiScheduled?.error &&
      chiRow.scheduledAt?.toISOString() === chiInstant?.toISOString() &&
      chiInstant?.toISOString() !== nyInstant?.toISOString(),
  );
  const chiRoute = await loadOwnerDayRoute(prisma, {
    businessId: businessChi.id,
    role: "OWNER",
    date: "2026-03-09",
    timeZone: CHI,
  });
  const nySameDate = await loadOwnerDayRoute(prisma, {
    businessId: businessNy.id,
    role: "OWNER",
    date: "2026-03-09",
    timeZone: NY,
  });
  check(
    "Day-route for one business timezone does not include the other tenant",
    chiRoute.stops.some((stop) => stop.jobId === chiJob.id) &&
      !nySameDate.stops.some((stop) => stop.jobId === chiJob.id),
  );

  setTestAccess(ownerNy);
  const dstGap = await scheduleJob(
    {},
    form({
      jobId: (
        await createApprovedJob(ownerNy, businessNy, customerNy, propertyNy)
      ).id,
      date: "2026-03-08",
      time: "02:30",
      durationPreset: "60",
    }),
  );
  check(
    "Spring-forward gap 02:30 America/New_York is refused",
    /valid date and start time/i.test(dstGap?.error ?? ""),
  );

  const dstEarly = await createApprovedJob(ownerNy, businessNy, customerNy, propertyNy);
  const dstLate = await createApprovedJob(ownerNy, businessNy, customerNy2, propertyNy2);
  const dstEarlyResult = await scheduleWithAck(dstEarly.id, {
    date: "2026-03-08",
    time: "01:30",
    durationPreset: "60",
  });
  const dstLateResult = await scheduleWithAck(dstLate.id, {
    date: "2026-03-08",
    time: "03:30",
    durationPreset: "60",
  });
  const dstRoute = await loadOwnerDayRoute(prisma, {
    businessId: businessNy.id,
    role: "OWNER",
    date: "2026-03-08",
    timeZone: NY,
  });
  check(
    "DST spring-forward day keeps both 01:30 EST and 03:30 EDT on the same route",
    !dstEarlyResult?.error &&
      !dstLateResult?.error &&
      dstRoute.stops.some((stop) => stop.jobId === dstEarly.id) &&
      dstRoute.stops.some((stop) => stop.jobId === dstLate.id) &&
      dstRoute.timeZone === NY,
  );

  console.log("\nBEHAVIOR — completed/cancelled refusal");
  const completedJob = await createApprovedJob(ownerNy, businessNy, customerNy, propertyNy);
  await scheduleWithAck(completedJob.id, {
    date: "2027-06-18",
    time: "09:00",
    durationPreset: "60",
  });
  await prisma.job.update({
    where: { id: completedJob.id },
    data: { status: "COMPLETED" },
  });
  const completedSchedule = await scheduleJob(
    {},
    form({
      jobId: completedJob.id,
      date: "2027-06-18",
      time: "11:00",
      durationPreset: "60",
    }),
  );
  const completedAssign = await assignJobMember(
    {},
    form({ jobId: completedJob.id, membershipId: memberMem.id }),
  );
  check(
    "Completed job cannot be rescheduled or assigned",
    completedSchedule?.error === JOB_COMPLETED_CANNOT_RESCHEDULE_MESSAGE &&
      completedAssign?.error === JOB_COMPLETED_CANNOT_ASSIGN_MESSAGE,
  );

  const cancelledJob = await createApprovedJob(ownerNy, businessNy, customerNy2, propertyNy2);
  await scheduleWithAck(cancelledJob.id, {
    date: "2027-06-18",
    time: "13:00",
    durationPreset: "60",
  });
  await prisma.job.update({
    where: { id: cancelledJob.id },
    data: { status: "CANCELLED" },
  });
  const cancelledSchedule = await scheduleJob(
    {},
    form({
      jobId: cancelledJob.id,
      date: "2027-06-18",
      time: "15:00",
      durationPreset: "60",
    }),
  );
  const cancelledAssign = await assignJobMember(
    {},
    form({ jobId: cancelledJob.id, membershipId: memberMem.id }),
  );
  const cancelledRow = await prisma.job.findFirstOrThrow({
    where: { id: cancelledJob.id, businessId: businessNy.id },
  });
  let cancelledDayRouteError = null;
  try {
    await changeOwnerDayRouteAppointment(prisma, ownerNy, {
      jobId: cancelledJob.id,
      date: "2027-06-18",
      time: "15:00",
      snapshot: scheduleSnapshotFromJob(cancelledRow),
    });
  } catch (error) {
    cancelledDayRouteError = error;
  }
  check(
    "Cancelled job cannot be rescheduled, assigned, or day-route changed",
    cancelledSchedule?.error === JOB_CANCELLED_CANNOT_RESCHEDULE_MESSAGE &&
      cancelledAssign?.error === JOB_CANCELLED_CANNOT_ASSIGN_MESSAGE &&
      dayRouteAppointmentErrorMessage(cancelledDayRouteError, "") ===
        DAY_ROUTE_APPOINTMENT_CANCELLED_MESSAGE,
  );
  check(
    "Completed day-route message stays the shared completed refusal",
    DAY_ROUTE_APPOINTMENT_COMPLETED_MESSAGE === JOB_COMPLETED_CANNOT_RESCHEDULE_MESSAGE,
  );

  console.log("\nBEHAVIOR — dedicated-DB races and concurrent edits");
  const raceHold = await createApprovedJob(ownerNy, businessNy, customerNy, propertyNy);
  const raceChallenger = await createApprovedJob(
    ownerNy,
    businessNy,
    customerNy2,
    propertyNy2,
  );
  let releaseHold;
  const held = new Promise((resolve) => {
    releaseHold = resolve;
  });
  jobWriteTestHooks.afterScheduleJobRead = async (jobId) => {
    if (jobId === raceHold.id) await held;
  };
  const holdPromise = scheduleJob(
    {},
    form({
      jobId: raceHold.id,
      date: "2027-06-21",
      time: "10:00",
      durationPreset: "60",
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const challengerResult = await scheduleJob(
    {},
    form({
      jobId: raceChallenger.id,
      date: "2027-06-21",
      time: "10:00",
      durationPreset: "60",
    }),
  );
  releaseHold();
  const holdResult = await holdPromise;
  jobWriteTestHooks.afterScheduleJobRead = undefined;
  const [holdRow, challengerRow] = await Promise.all([
    prisma.job.findFirst({
      where: { id: raceHold.id, businessId: businessNy.id },
      select: { scheduledAt: true, status: true },
    }),
    prisma.job.findFirst({
      where: { id: raceChallenger.id, businessId: businessNy.id },
      select: { scheduledAt: true, status: true },
    }),
  ]);
  const written = [holdRow, challengerRow].filter((row) => row?.scheduledAt);
  const warned = [holdResult, challengerResult].filter((result) => result?.warning);
  check(
    "Concurrent scheduleJob into the same slot writes one job and warns the other",
    written.length === 1 &&
      warned.length === 1 &&
      !holdResult?.error &&
      !challengerResult?.error,
  );

  const inProgressJob = await createApprovedJob(
    ownerNy,
    businessNy,
    customerNy,
    propertyNy,
  );
  jobWriteTestHooks.afterScheduleJobRead = async (jobId) => {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "IN_PROGRESS" },
    });
  };
  const inProgressSchedule = await scheduleJob(
    {},
    form({
      jobId: inProgressJob.id,
      date: "2027-06-22",
      time: "09:00",
      durationPreset: "60",
    }),
  );
  jobWriteTestHooks.afterScheduleJobRead = undefined;
  const inProgressRow = await prisma.job.findFirstOrThrow({
    where: { id: inProgressJob.id, businessId: businessNy.id },
    select: { status: true, scheduledAt: true },
  });
  check(
    "scheduleJob does not overwrite IN_PROGRESS back to SCHEDULED",
    !inProgressSchedule?.error &&
      inProgressRow.status === "IN_PROGRESS" &&
      Boolean(inProgressRow.scheduledAt),
  );

  const cancelRaceJob = await createApprovedJob(
    ownerNy,
    businessNy,
    customerNy,
    propertyNy,
  );
  jobWriteTestHooks.afterScheduleJobRead = async (jobId) => {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "CANCELLED" },
    });
  };
  const cancelRace = await scheduleJob(
    {},
    form({
      jobId: cancelRaceJob.id,
      date: "2027-06-22",
      time: "11:00",
      durationPreset: "60",
    }),
  );
  jobWriteTestHooks.afterScheduleJobRead = undefined;
  const cancelRaceRow = await prisma.job.findFirstOrThrow({
    where: { id: cancelRaceJob.id, businessId: businessNy.id },
    select: { status: true, scheduledAt: true },
  });
  check(
    "Stale scheduleJob cannot schedule a job cancelled after the initial read",
    cancelRace?.error === JOB_CANCELLED_CANNOT_RESCHEDULE_MESSAGE &&
      cancelRaceRow.status === "CANCELLED" &&
      cancelRaceRow.scheduledAt == null,
  );

  const dayRouteRaceJob = await createApprovedJob(
    ownerNy,
    businessNy,
    customerNy,
    propertyNy,
  );
  await scheduleWithAck(dayRouteRaceJob.id, {
    date: "2027-06-22",
    time: "09:30",
    durationPreset: "60",
  });
  const dayRouteRaceRow = await prisma.job.findFirstOrThrow({
    where: { id: dayRouteRaceJob.id, businessId: businessNy.id },
  });
  const dayRouteRaceScheduledAt = dayRouteRaceRow.scheduledAt;
  dayRouteAppointmentTestHooks.afterDayRouteAppointmentRead = async (jobId) => {
    if (jobId === dayRouteRaceJob.id) {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: "CANCELLED" },
      });
    }
  };
  let dayRouteRaceError = null;
  try {
    await changeOwnerDayRouteAppointment(prisma, ownerNy, {
      jobId: dayRouteRaceJob.id,
      date: "2027-06-22",
      time: "10:30",
      snapshot: scheduleSnapshotFromJob(dayRouteRaceRow),
    });
  } catch (error) {
    dayRouteRaceError = error;
  }
  dayRouteAppointmentTestHooks.afterDayRouteAppointmentRead = undefined;
  const dayRouteRaceAfter = await prisma.job.findFirstOrThrow({
    where: { id: dayRouteRaceJob.id, businessId: businessNy.id },
    select: { status: true, scheduledAt: true },
  });
  check(
    "Stale day-route change cannot move a job cancelled after the initial read",
    dayRouteAppointmentErrorMessage(dayRouteRaceError, "") ===
      DAY_ROUTE_APPOINTMENT_CANCELLED_MESSAGE &&
      dayRouteRaceAfter.status === "CANCELLED" &&
      dayRouteRaceAfter.scheduledAt?.toISOString() ===
        dayRouteRaceScheduledAt?.toISOString(),
  );

  const assignRaceJob = await createApprovedJob(
    ownerNy,
    businessNy,
    customerNy2,
    propertyNy2,
  );
  await scheduleWithAck(assignRaceJob.id, {
    date: "2027-06-22",
    time: "13:00",
    durationPreset: "60",
  });
  jobAssignmentTestHooks.beforeAssignmentLock = async ({ jobId }) => {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "COMPLETED" },
    });
  };
  const assignRace = await assignJobMember(
    {},
    form({ jobId: assignRaceJob.id, membershipId: memberMem.id }),
  );
  jobAssignmentTestHooks.beforeAssignmentLock = undefined;
  const assignRaceRow = await prisma.job.findFirstOrThrow({
    where: { id: assignRaceJob.id, businessId: businessNy.id },
    select: { status: true, assignedMembershipId: true },
  });
  check(
    "Stale assignJobMember cannot assign a job completed after the initial read",
    assignRace?.error === JOB_COMPLETED_CANNOT_ASSIGN_MESSAGE &&
      assignRaceRow.status === "COMPLETED" &&
      assignRaceRow.assignedMembershipId == null,
  );

  const twoClientA = await createApprovedJob(ownerNy, businessNy, customerNy, propertyNy);
  const twoClientB = await createApprovedJob(ownerNy, businessNy, customerNy2, propertyNy2);
  const secondClient = session.createClient();
  check(
    "Dedicated-DB race uses a second PrismaClient on the same database",
    typeof secondClient?.$transaction === "function" &&
      typeof secondClient?.$executeRaw === "function",
  );
  const [left, right] = await Promise.all([
    scheduleJob(
      {},
      form({
        jobId: twoClientA.id,
        date: "2027-06-23",
        time: "10:00",
        durationPreset: "60",
      }),
    ),
    scheduleJob(
      {},
      form({
        jobId: twoClientB.id,
        date: "2027-06-23",
        time: "10:00",
        durationPreset: "60",
      }),
    ),
  ]);
  const [leftRow, rightRow] = await Promise.all([
    prisma.job.findFirst({
      where: { id: twoClientA.id, businessId: businessNy.id },
      select: { scheduledAt: true },
    }),
    prisma.job.findFirst({
      where: { id: twoClientB.id, businessId: businessNy.id },
      select: { scheduledAt: true },
    }),
  ]);
  const concurrentWritten = [leftRow, rightRow].filter((row) => row?.scheduledAt);
  const concurrentWarned = [left, right].filter((result) => result?.warning);
  check(
    "Parallel scheduleJob clients serialize on the reservation lock",
    concurrentWritten.length === 1 &&
      concurrentWarned.length === 1 &&
      !left?.error &&
      !right?.error,
  );

  if (failed > 0) {
    throw new Error(`${failed} web-scheduling check(s) failed`);
  }
} finally {
  await session.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}

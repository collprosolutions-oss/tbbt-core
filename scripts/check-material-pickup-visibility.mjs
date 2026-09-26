/**
 * Materials pickup operational visibility.
 *
 * Job.pickupDurationMinutes is already persisted and already consumed by
 * scheduling. This check proves owner Today and the assigned Field Job
 * page now show that recorded duration without inventing a second pickup
 * model, store, route, or time-card mutation.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-material-pickup-visibility.mjs
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { formatTime } = await import("@/lib/format");
const { resolveBusinessTimeZone } = await import("@/lib/business-timezone");
const {
  MATERIAL_PICKUP_SCHEDULED_HEADING,
  MATERIAL_PICKUP_SCHEDULED_NOTE,
  buildMaterialPickupVisibility,
  buildOwnerTodayJobView,
  buildOwnerTodayJobs,
  materialPickupBlockStart,
  ownerTodayMaterialPickupRecorded,
  recordedPickupDurationMinutes,
} = await import("@/lib/owner-today");

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

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

const ownerTodaySrc = readRepo("src/lib/owner-today.ts");
const ownerCardSrc = readRepo("src/components/today/owner-today-job-card.tsx");
const fieldPageSrc = readRepo("src/app/field/jobs/[jobId]/page.tsx");
const pickupCardSrc = readRepo("src/components/field/assigned-job-pickup-card.tsx");
const todayPageSrc = readRepo("src/app/(app)/today/page.tsx");
const jobActionSrc = readRepo("src/app/actions/job.ts");
const fieldActionSrc = readRepo("src/app/actions/field-job.ts");
const scheduleSrc = readRepo("src/lib/schedule.ts");
const availabilitySrc = readRepo("src/lib/availability.ts");
const scheduleFormSrc = readRepo("src/components/jobs/schedule-job-form.tsx");
const fieldAccessSrc = readRepo("src/lib/field-access.ts");
const startButtonSrc = readRepo("src/components/field/start-assigned-job-button.tsx");
const timeCardOpsSrc = readRepo("src/lib/time-card-ops.ts");

const jobSelectMatch = fieldPageSrc.match(
  /const job = await prisma\.job\.findFirst\(\{[\s\S]*?\n  \}\);/,
);
const jobSelectSrc = jobSelectMatch?.[0] ?? "";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const appointment = new Date("2026-09-26T13:00:00.000Z");
const pickupStart = materialPickupBlockStart(appointment, 30);
const todayRange = {
  start: new Date("2026-09-26T00:00:00.000Z"),
  end: new Date("2026-09-27T00:00:00.000Z"),
};

function todayJob(extras = {}) {
  return {
    id: extras.id ?? "job-today",
    businessId: extras.businessId ?? "biz-a",
    customerId: extras.customerId ?? "cust-a",
    status: extras.status ?? "SCHEDULED",
    scheduledAt: extras.scheduledAt === undefined ? appointment : extras.scheduledAt,
    scheduledDurationMinutes: extras.scheduledDurationMinutes ?? 60,
    arrivalWindowMinutes: extras.arrivalWindowMinutes ?? null,
    pickupDurationMinutes:
      extras.pickupDurationMinutes === undefined ? 30 : extras.pickupDurationMinutes,
    assignedMembershipId: extras.assignedMembershipId ?? "mem-1",
    projectToken: extras.projectToken ?? "portal-today",
    appointmentConfirmationStatus: extras.appointmentConfirmationStatus ?? "CONFIRMED",
    appointmentProposalId: extras.appointmentProposalId ?? 1,
    appointmentConfirmedForProposalId: extras.appointmentConfirmedForProposalId ?? 1,
    appointmentConfirmationSource: extras.appointmentConfirmationSource ?? "PORTAL",
    appointmentChangeRequestNote: extras.appointmentChangeRequestNote ?? null,
    appointmentNotificationStatus: extras.appointmentNotificationStatus ?? "SENT",
    appointmentNotificationError: extras.appointmentNotificationError ?? null,
    appointmentNotifiedForProposalId: extras.appointmentNotifiedForProposalId ?? 1,
    propertyAccessMethod: extras.propertyAccessMethod ?? "CUSTOMER_PRESENT",
    propertyAccessInstructions: extras.propertyAccessInstructions ?? null,
    propertyAccessContactName: extras.propertyAccessContactName ?? null,
    propertyAccessContactInfo: extras.propertyAccessContactInfo ?? null,
    propertyAccessPickupLocation: extras.propertyAccessPickupLocation ?? null,
    propertyAccessNote: extras.propertyAccessNote ?? null,
    customer: extras.customer ?? {
      id: extras.customerId ?? "cust-a",
      name: extras.customerName ?? "Pat",
      phone: "555-0147",
    },
    property: extras.property ?? {
      addressLine1: "10 Main St",
      city: "Austin",
      region: "TX",
      postalCode: "78701",
    },
    assignedMembership: extras.assignedMembership ?? { user: { name: "Alex" } },
    ...extras,
  };
}

console.log("\nSTATIC — One persisted pickup duration, no second model");
check(
  "Owner Today still loads Job.pickupDurationMinutes through OWNER_TODAY_JOB_SELECT",
  ownerTodaySrc.includes("pickupDurationMinutes: true") &&
    ownerTodaySrc.includes("export const OWNER_TODAY_JOB_SELECT") &&
    ownerTodaySrc.includes("recordedPickupDurationMinutes") &&
    ownerTodaySrc.includes("buildMaterialPickupVisibility"),
);
check(
  "Field Job page selects pickupDurationMinutes on the existing assignment-scoped query",
  (fieldPageSrc.match(/prisma\.job\.findFirst/g) ?? []).length === 1 &&
    jobSelectSrc.includes("pickupDurationMinutes: true") &&
    jobSelectSrc.includes("where: assignedJobWhere(jobId, field)"),
);
check(
  "No second pickup duration, schedule, or materials model was added",
  !ownerTodaySrc.includes("routePickup") &&
    !ownerTodaySrc.includes("supplierAddress") &&
    !ownerTodaySrc.includes("travelDurationMinutes") &&
    !ownerCardSrc.includes("Home Depot") &&
    !ownerCardSrc.includes("Lowe") &&
    !fieldPageSrc.includes("Home Depot") &&
    !fieldPageSrc.includes("Lowe") &&
    !pickupCardSrc.includes("Home Depot") &&
    !fieldPageSrc.includes('from "@/lib/schedule"') &&
    !fieldPageSrc.includes("loadAvailabilitySnapshot") &&
    !ownerTodaySrc.includes("prisma.materialPurchaseListItem"),
);
check(
  "Forbidden production files were not rewritten for this visibility work",
  todayPageSrc.includes("requireManagementPageAccess()") &&
    todayPageSrc.includes("buildOwnerTodayJobs") &&
    jobActionSrc.includes("pickupDurationMinutes") &&
    scheduleFormSrc.includes('name="pickupDurationMinutes"') &&
    scheduleSrc.includes("groupJobsByDay") &&
    availabilitySrc.includes("export") &&
    fieldActionSrc.includes("completeJobWithRunningTimeSafety"),
);

console.log("\nSTATIC — Owner Today card shows recorded pickup time");
check(
  "Today job card renders duration + pickup block from the view-model",
  ownerCardSrc.includes("job.materialPickup.recorded") &&
    ownerCardSrc.includes("min before appointment") &&
    ownerCardSrc.includes("job.materialPickup.blockLabel") &&
    ownerCardSrc.includes("job.materialPickup.scheduledNote") &&
    !ownerCardSrc.includes("Pickup recorded"),
);
check(
  "No pickup duration does not invent 0-minute workflow copy",
  ownerCardSrc.includes("job.materialPickup.recorded ?") &&
    !ownerCardSrc.includes("0 min before appointment") &&
    !ownerCardSrc.includes("Materials pickup: 0"),
);
check(
  "Today Call / Directions / assignment / Start controls stay on the card",
  ownerCardSrc.includes("job.callHref") &&
    ownerCardSrc.includes(">Call<") &&
    ownerCardSrc.includes("job.directionsHref") &&
    ownerCardSrc.includes("Directions") &&
    ownerCardSrc.includes("job.assignment.kind === \"UNASSIGNED\"") &&
    ownerCardSrc.includes("AssignJobMemberForm") &&
    ownerCardSrc.includes("StartJobButton") &&
    ownerCardSrc.includes("showStart && job.canStart && job.appointmentConfirmed") &&
    ownerCardSrc.includes("CopyProjectLinkButton") &&
    ownerCardSrc.includes("job.fieldHref"),
);

console.log("\nSTATIC — Field page shows recorded pickup without mutating time");
check(
  "Field page builds visibility from Job.pickupDurationMinutes + Business.timezone",
  fieldPageSrc.includes("buildMaterialPickupVisibility") &&
    fieldPageSrc.includes("pickupDurationMinutes: job.pickupDurationMinutes") &&
    fieldPageSrc.includes("resolveBusinessTimeZone(field.workspace.business)") &&
    fieldPageSrc.includes("scheduledPickup={materialPickup}"),
);
check(
  "Field heading and minutes are readable text, not icon-only / hover-only",
  pickupCardSrc.includes("MATERIAL_PICKUP_SCHEDULED_HEADING") &&
    pickupCardSrc.includes("scheduledPickup.minutesLabel") &&
    pickupCardSrc.includes("text-base") &&
    pickupCardSrc.includes("This does not start a time card.") &&
    !pickupCardSrc.includes("title={") &&
    !pickupCardSrc.includes("onMouseEnter") &&
    !pickupCardSrc.includes("sr-only"),
);
check(
  "Existing recorded pickup items still render from listAssignedJobPickupView",
  fieldPageSrc.includes("listAssignedJobPickupView(prisma, field, job.id)") &&
    pickupCardSrc.includes("items.map((item)") &&
    pickupCardSrc.includes("item.supplierName ?? \"No supplier listed\"") &&
    pickupCardSrc.includes("item.pickupLocationDescription") &&
    pickupCardSrc.includes("Pickup for this assigned job only") &&
    pickupCardSrc.includes("if (!hasScheduledPickup && items.length === 0) return null"),
);
check(
  "Field page does not auto-start a time card or invent MATERIAL_PICKUP clocking",
  !fieldPageSrc.includes("clockInTime") &&
    !fieldPageSrc.includes("clockOutTime") &&
    !fieldPageSrc.includes("MATERIAL_PICKUP") &&
    !pickupCardSrc.includes("clockInTime") &&
    !pickupCardSrc.includes("MATERIAL_PICKUP") &&
    !pickupCardSrc.includes("startAssignedJob") &&
    fieldPageSrc.includes("<FieldTimeClock") &&
    pickupCardSrc.includes("This does not start a time card."),
);
check(
  "#144 assignment-scoped Field access is unchanged",
  fieldPageSrc.includes("await requireAssignedJobPageAccess(jobId)") &&
    fieldPageSrc.includes("where: assignedJobWhere(jobId, field)") &&
    fieldAccessSrc.includes("assignedMembershipId: field.membershipId") &&
    !fieldAccessSrc.includes('role === "OWNER"') &&
    !fieldAccessSrc.includes('role === "ADMIN"'),
);
check(
  "#150 appointment-readiness copy and Start gating stay intact",
  fieldPageSrc.includes("Appointment time: ${formatDateTime(job.scheduledAt, timeZone)}") &&
    fieldPageSrc.includes("Arrival window:") &&
    fieldPageSrc.includes("job.arrivalWindowMinutes * 60 * 1000") &&
    fieldPageSrc.includes("scheduled={job.scheduledAt != null}") &&
    fieldPageSrc.includes("appointmentConfirmed={isCurrentAppointmentConfirmed(job)}") &&
    startButtonSrc.includes("Waiting for the office to schedule this job.") &&
    startButtonSrc.includes("Customer has not confirmed this appointment.") &&
    startButtonSrc.includes("if (!scheduled)") &&
    startButtonSrc.includes("if (!appointmentConfirmed)"),
);
check(
  "Field Call Customer / Directions / completion safety stay intact",
  fieldPageSrc.includes("Call Customer") &&
    fieldPageSrc.includes("Directions") &&
    fieldPageSrc.includes("This job is complete.") &&
    fieldPageSrc.includes("{isInProgress ? <CompleteAssignedJobButton jobId={job.id} /> : null}") &&
    fieldActionSrc.includes("completeJobWithRunningTimeSafety") &&
    timeCardOpsSrc.includes("JOB_COMPLETION_TIME_CLOSED_REASON"),
);

console.log("\nUNIT — Recorded duration and pickup-block math");
check(
  "recordedPickupDurationMinutes keeps > 0 and rejects null/0",
  recordedPickupDurationMinutes(30) === 30 &&
    recordedPickupDurationMinutes(null) === null &&
    recordedPickupDurationMinutes(undefined) === null &&
    recordedPickupDurationMinutes(0) === null &&
    ownerTodayMaterialPickupRecorded(30) === true &&
    ownerTodayMaterialPickupRecorded(0) === false &&
    ownerTodayMaterialPickupRecorded(null) === false,
);
check(
  "pickup-block start is scheduledAt minus recorded minutes",
  pickupStart.toISOString() === "2026-09-26T12:30:00.000Z" &&
    formatTime(appointment, NY) === "9:00 AM" &&
    formatTime(pickupStart, NY) === "8:30 AM",
);

const nyPickup = buildMaterialPickupVisibility(
  { scheduledAt: appointment, pickupDurationMinutes: 30 },
  NY,
);
const laPickup = buildMaterialPickupVisibility(
  { scheduledAt: appointment, pickupDurationMinutes: 30 },
  LA,
);
const nonePickup = buildMaterialPickupVisibility(
  { scheduledAt: appointment, pickupDurationMinutes: null },
  NY,
);
const zeroPickup = buildMaterialPickupVisibility(
  { scheduledAt: appointment, pickupDurationMinutes: 0 },
  NY,
);
const unscheduledPickup = buildMaterialPickupVisibility(
  { scheduledAt: null, pickupDurationMinutes: 30 },
  NY,
);
const completedPickup = buildMaterialPickupVisibility(
  { scheduledAt: appointment, pickupDurationMinutes: 30 },
  NY,
);

check(
  "scheduled job + 30 pickup minutes shows owner duration and 8:30–9:00 NY block",
  nyPickup.recorded === true &&
    nyPickup.durationMinutes === 30 &&
    nyPickup.durationLabel === "Materials pickup: 30 min before appointment" &&
    nyPickup.minutesLabel === "30 minutes" &&
    nyPickup.blockLabel === "Pickup block: 8:30 AM – 9:00 AM" &&
    nyPickup.scheduledNote === MATERIAL_PICKUP_SCHEDULED_NOTE &&
    MATERIAL_PICKUP_SCHEDULED_HEADING === "Materials pickup scheduled before this job",
);
check(
  "same UTC instant renders the LA pickup block, not the NY clock",
  laPickup.recorded === true &&
    laPickup.durationMinutes === 30 &&
    formatTime(appointment, LA) === "6:00 AM" &&
    formatTime(pickupStart, LA) === "5:30 AM" &&
    laPickup.blockLabel === "Pickup block: 5:30 AM – 6:00 AM" &&
    nyPickup.blockLabel !== laPickup.blockLabel &&
    resolveBusinessTimeZone({ timezone: NY }) === NY &&
    resolveBusinessTimeZone({ timezone: LA }) === LA,
);
check(
  "no pickup duration -> no fake pickup section",
  nonePickup.recorded === false &&
    nonePickup.durationLabel === null &&
    nonePickup.blockLabel === null &&
    nonePickup.minutesLabel === null &&
    zeroPickup.recorded === false &&
    zeroPickup.durationLabel === null &&
    zeroPickup.blockLabel === null,
);
check(
  "unscheduled + pickup duration does not fabricate clock times",
  unscheduledPickup.recorded === true &&
    unscheduledPickup.durationMinutes === 30 &&
    unscheduledPickup.durationLabel === "Materials pickup: 30 min before appointment" &&
    unscheduledPickup.minutesLabel === "30 minutes" &&
    unscheduledPickup.blockLabel === null,
);
check(
  "completed job may keep historical duration and adds no action copy",
  completedPickup.recorded === true &&
    completedPickup.durationMinutes === 30 &&
    completedPickup.blockLabel === "Pickup block: 8:30 AM – 9:00 AM" &&
    !ownerCardSrc.includes("Start pickup") &&
    !pickupCardSrc.includes("Start pickup") &&
    !pickupCardSrc.includes("Clock MATERIAL_PICKUP") &&
    fieldPageSrc.includes("This job is complete."),
);

console.log("\nUNIT — Owner Today view-model");
const scheduledView = buildOwnerTodayJobView(todayJob(), {
  businessId: "biz-a",
  range: todayRange,
  timeZone: NY,
  viewerMembershipId: "mem-1",
});
const noPickupView = buildOwnerTodayJobView(
  todayJob({ id: "job-none", pickupDurationMinutes: null }),
  { businessId: "biz-a", range: todayRange, timeZone: NY },
);
const zeroPickupView = buildOwnerTodayJobView(
  todayJob({ id: "job-zero", pickupDurationMinutes: 0 }),
  { businessId: "biz-a", range: todayRange, timeZone: LA },
);
const completedView = buildOwnerTodayJobView(
  todayJob({ id: "job-done", status: "COMPLETED", pickupDurationMinutes: 30 }),
  { businessId: "biz-a", range: todayRange, timeZone: NY },
);
const foreignView = buildOwnerTodayJobView(todayJob({ businessId: "biz-b" }), {
  businessId: "biz-a",
  range: todayRange,
  timeZone: NY,
});
const laView = buildOwnerTodayJobView(todayJob({ id: "job-la" }), {
  businessId: "biz-a",
  range: todayRange,
  timeZone: LA,
});

check(
  "Owner Today scheduled job exposes 30-minute pickup and NY block",
  scheduledView?.materialPickupRecorded === true &&
    scheduledView.materialPickup.durationMinutes === 30 &&
    scheduledView.materialPickup.durationLabel ===
      "Materials pickup: 30 min before appointment" &&
    scheduledView.materialPickup.blockLabel === "Pickup block: 8:30 AM – 9:00 AM" &&
    scheduledView.callHref === "tel:555-0147" &&
    scheduledView.directionsHref != null &&
    scheduledView.canStart === true &&
    scheduledView.fieldHref === "/field/jobs/job-today",
);
check(
  "Owner Today honors Business.timezone for the same UTC appointment",
  laView?.materialPickup.blockLabel === "Pickup block: 5:30 AM – 6:00 AM" &&
    scheduledView?.timeWindowLabel?.includes("9:00 AM") &&
    laView?.timeWindowLabel?.includes("6:00 AM"),
);
check(
  "Owner Today hides pickup when duration is missing or zero",
  noPickupView?.materialPickupRecorded === false &&
    noPickupView.materialPickup.durationLabel === null &&
    noPickupView.materialPickup.blockLabel === null &&
    zeroPickupView?.materialPickupRecorded === false &&
    zeroPickupView.materialPickup.blockLabel === null,
);
check(
  "Completed Today job keeps historical pickup and cannot Start",
  completedView?.status === "COMPLETED" &&
    completedView.materialPickupRecorded === true &&
    completedView.materialPickup.durationMinutes === 30 &&
    completedView.canStart === false,
);
check(
  "Owner Today remains business-scoped",
  foreignView === null &&
    buildOwnerTodayJobs([todayJob({ businessId: "biz-b" })], {
      businessId: "biz-a",
      range: todayRange,
      timeZone: NY,
    }).length === 0,
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

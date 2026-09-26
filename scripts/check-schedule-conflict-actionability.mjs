/**
 * Schedule-conflict actionability: overlapping recorded Jobs become
 * owner-visible facts with an Open conflicting job link, without changing
 * the existing availability engine or Schedule-anyway acknowledgement.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-schedule-conflict-actionability.mjs
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  DEFAULT_AVAILABILITY_SETTINGS,
  conflictingJobHref,
  describeScheduleWarning,
  evaluateProposedSchedule,
  formatNextAvailableDateTime,
  hasScheduleWarning,
  overlappingOccupiedJobs,
  scheduleConflictFacts,
} = await import("@/lib/availability");
const { schedulesOverlapWithBuffer } = await import("@/lib/job-schedule");
const { zonedCivilToUtc } = await import("@/lib/business-timezone");
const { formatDateTime } = await import("@/lib/format");
const {
  conflictAcknowledgement,
  shouldAcceptConflictAcknowledgement,
} = await import("@/lib/workforce-window");

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

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function sourceOfExportedFunction(src, name) {
  const match = src.match(new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}\\n`));
  return match?.[0] ?? "";
}

const form = readRepo("src/components/jobs/schedule-job-form.tsx");
const jobAction = readRepo("src/app/actions/job.ts");
const availability = readRepo("src/lib/availability.ts");
const availabilityData = readRepo("src/lib/availability-data.ts");
const scheduleLib = readRepo("src/lib/schedule.ts");
const scheduleJobSrc = sourceOfExportedFunction(jobAction, "scheduleJob");

const NY = "America/New_York";
const LA = "America/Los_Angeles";
function civil(year, month, day, hour = 0, minute = 0, timeZone = NY) {
  return zonedCivilToUtc(year, month, day, hour, minute, 0, timeZone);
}

console.log("\nSTATIC — Owned files, existing engine, and Schedule anyway");

check(
  "Verification is limited to the owned scheduling-form files",
  form.includes("Open conflicting job") &&
    jobAction.includes("ownedScheduleConflictFacts") &&
    availability.includes("scheduleConflictFacts") &&
    availability.includes("overlappingOccupiedJobs"),
);
check(
  "scheduleJob still evaluates availability with evaluateProposedSchedule",
  scheduleJobSrc.includes("evaluateProposedSchedule") &&
    scheduleJobSrc.includes("describeScheduleWarning") &&
    scheduleJobSrc.includes("loadOccupiedJobs(prisma, access.businessId, job.id)"),
);
check(
  "Conflict acknowledgement is still recomputed server-side",
  scheduleJobSrc.includes("confirmOverlapAck") &&
    scheduleJobSrc.includes("shouldAcceptConflictAcknowledgement") &&
    scheduleJobSrc.includes("conflictAcknowledgement") &&
    !scheduleJobSrc.includes("Schedule anyway"),
);
check("Owner form still has Schedule anyway after a warning", form.includes("Schedule anyway"));
check(
  "Schedule anyway still submits only the current confirmOverlapAck",
  form.includes('name="confirmOverlapAck"') &&
    form.includes("state.conflictAck") &&
    !form.includes('name="conflicts"') &&
    !form.includes('name="conflictJobId"'),
);
check(
  "Overlap warning UI is titled Schedule conflict and lists Open conflicting job",
  form.includes("<AlertTitle>Schedule conflict</AlertTitle>") &&
    form.includes("Open conflicting job") &&
    form.includes("state.conflicts"),
);
check(
  "Open conflicting job is a normal Link to /jobs/<jobId>",
  form.includes('import Link from "next/link"') &&
    form.includes("href={`/jobs/${conflict.jobId}`}") &&
    form.includes("<Link href={`/jobs/${conflict.jobId}`}>"),
);
check(
  "Conflict times on the form are preformatted labels, not browser-local",
  form.includes("conflict.scheduledStartLabel") &&
    form.includes("conflict.expectedEndLabel") &&
    !/toLocale(?:Date|Time)?String/.test(
      form.slice(form.indexOf("state.conflicts"), form.indexOf("Schedule anyway")),
    ),
);
check(
  "Conflict facts are loaded only for the authenticated Business",
  jobAction.includes("async function ownedScheduleConflictFacts") &&
    jobAction.includes("id: { in: overlapIds }") &&
    jobAction.includes("businessId,") &&
    jobAction.includes("scheduleConflictFacts(overlaps, timeZone, ownedById)"),
);
check(
  "Occupied jobs used for overlap still come from the tenant-scoped loader",
  availabilityData.includes("businessId,") &&
    availabilityData.includes('status: { not: "COMPLETED" }') &&
    /loadOccupiedJobs\([\s\S]*where: \{[\s\S]*businessId/.test(availabilityData),
);
check(
  "scheduleJob still mutates only the target Job row",
  scheduleJobSrc.includes("where: { id: job.id }") &&
    scheduleJobSrc.includes("scheduledAt: start") &&
    !/prisma\.job\.updateMany/.test(scheduleJobSrc) &&
    !/prisma\.job\.create\(/.test(scheduleJobSrc),
);
check(
  "No automatic reschedule of the other recorded Job",
  !scheduleJobSrc.includes("laterJobsHurtByMove") === false &&
    scheduleJobSrc.includes("Later jobs were not moved.") &&
    !scheduleJobSrc.includes("prisma.job.update({") === false,
);
check(
  "Existing appointment notification still runs after a material schedule",
  scheduleJobSrc.includes("notifyCustomerAppointmentProposed") &&
    scheduleJobSrc.includes("recordAppointmentEvent") &&
    /await prisma\.job\.update\([\s\S]*notifyCustomerAppointmentProposed/.test(scheduleJobSrc),
);
check(
  "Browser-submitted conflict IDs are not treated as proof of schedule state",
  !scheduleJobSrc.includes('readString(formData, "conflicts")') &&
    !scheduleJobSrc.includes('readString(formData, "conflictJobId")') &&
    scheduleJobSrc.includes("evaluation.overlaps"),
);
check(
  "Calendar schedule module was not redesigned",
  !scheduleLib.includes("Open conflicting job") &&
    !scheduleLib.includes("scheduleConflictFacts"),
);
check(
  "Overlap identification still uses the existing buffer window math",
  availability.includes("schedulesOverlapWithBuffer") &&
    overlappingOccupiedJobs.toString().includes("schedulesOverlapWithBuffer"),
);

console.log("\nUNIT — Exact overlap set and actionable facts");

const settings = { ...DEFAULT_AVAILABILITY_SETTINGS };
const alpha = {
  id: "job-alpha",
  scheduledAt: civil(2026, 9, 7, 8, 0),
  scheduledDurationMinutes: 60,
  customerName: "Alpha",
};
const bravo = {
  id: "job-bravo",
  scheduledAt: civil(2026, 9, 7, 8, 30),
  scheduledDurationMinutes: 60,
  customerName: "Bravo",
};
const laterSameDay = {
  id: "job-later",
  scheduledAt: civil(2026, 9, 7, 14, 0),
  scheduledDurationMinutes: 60,
  customerName: "Later Same Day",
};
const otherWorkerOverlap = {
  id: "job-other-worker",
  scheduledAt: civil(2026, 9, 7, 8, 15),
  scheduledDurationMinutes: 30,
  customerName: "Other Crew",
  assignedMembershipId: "member-other",
};
const foreign = {
  id: "job-foreign",
  scheduledAt: civil(2026, 9, 7, 8, 0),
  scheduledDurationMinutes: 120,
  customerName: "Foreign Tenant",
};
const noDuration = {
  id: "job-no-duration",
  scheduledAt: civil(2026, 9, 7, 8, 0),
  scheduledDurationMinutes: null,
  customerName: "No Duration",
};
const unassigned = {
  id: "job-unassigned",
  scheduledAt: civil(2026, 9, 7, 8, 0),
  scheduledDurationMinutes: 60,
  customerName: null,
  assignedMembershipId: null,
  assignmentKnown: true,
};

const proposed = civil(2026, 9, 7, 8, 45);
const twoConflictEval = evaluateProposedSchedule({
  start: proposed,
  durationMinutes: 60,
  settings,
  existing: [alpha, bravo, laterSameDay],
  timeZone: NY,
});

check(
  "Overlapping same-tenant Job produces a warning",
  Boolean(twoConflictEval.overlap) && hasScheduleWarning(twoConflictEval),
);
check(
  "Warning identifies the actual conflicting Job by recorded customer name",
  describeScheduleWarning(
    twoConflictEval,
    proposed,
    (value) => formatDateTime(value, NY),
    settings,
    NY,
  )?.includes("Alpha") === true,
);
check(
  "Two real overlaps are both returned by the existing overlap rule",
  twoConflictEval.overlaps.map((job) => job.id).join(",") === "job-alpha,job-bravo" &&
    schedulesOverlapWithBuffer(
      proposed,
      60,
      alpha.scheduledAt,
      alpha.scheduledDurationMinutes,
      settings.schedulingBufferMinutes,
    ) &&
    schedulesOverlapWithBuffer(
      proposed,
      60,
      bravo.scheduledAt,
      bravo.scheduledDurationMinutes,
      settings.schedulingBufferMinutes,
    ),
);
check(
  "A non-overlapping same-day Job is not listed",
  !twoConflictEval.overlaps.some((job) => job.id === "job-later") &&
    !schedulesOverlapWithBuffer(
      proposed,
      60,
      laterSameDay.scheduledAt,
      laterSameDay.scheduledDurationMinutes,
      settings.schedulingBufferMinutes,
    ),
);

const otherCrewEval = evaluateProposedSchedule({
  start: proposed,
  durationMinutes: 60,
  settings,
  existing: [laterSameDay, otherWorkerOverlap],
  timeZone: NY,
});
check(
  "Another worker is listed only when the current overlap rule says they conflict",
  otherCrewEval.overlaps.map((job) => job.id).join(",") === "job-other-worker" &&
    !otherCrewEval.overlaps.some((job) => job.id === "job-later"),
);

const ownedTwo = new Map([
  [alpha.id, { ...alpha, assignmentKnown: true, assignedMembershipId: "member-a", assignedWorkerName: "Pat" }],
  [bravo.id, { ...bravo, assignmentKnown: true, assignedMembershipId: null }],
]);
const twoFacts = scheduleConflictFacts(twoConflictEval.overlaps, NY, ownedTwo);
check(
  "Actionable facts include both real conflicts and no unrelated Job",
  twoFacts.map((row) => row.jobId).join(",") === "job-alpha,job-bravo" &&
    !twoFacts.some((row) => row.jobId === "job-later"),
);
check(
  "Open conflicting job href is /jobs/<correct-id> for each overlap",
  twoFacts[0]?.href === "/jobs/job-alpha" &&
    twoFacts[1]?.href === "/jobs/job-bravo" &&
    conflictingJobHref("job-alpha") === "/jobs/job-alpha",
);
check(
  "Recorded worker name is shown; recorded unassigned stays Unassigned",
  twoFacts[0]?.assignedWorkerName === "Pat" && twoFacts[1]?.assignedWorkerName === "Unassigned",
);

const smuggled = scheduleConflictFacts(
  [...twoConflictEval.overlaps, foreign],
  NY,
  ownedTwo,
);
check(
  "A foreign-tenant Job never appears in detail, href, or serialized facts",
  smuggled.every((row) => row.jobId !== "job-foreign") &&
    !smuggled.some((row) => (row.href ?? "").includes("job-foreign")) &&
    !smuggled.some((row) => (row.customerName ?? "").includes("Foreign")),
);

const missingDurationEval = evaluateProposedSchedule({
  start: civil(2026, 9, 7, 8, 10),
  durationMinutes: 60,
  settings,
  existing: [noDuration],
  timeZone: NY,
});
const missingDurationFacts = scheduleConflictFacts(
  missingDurationEval.overlaps,
  NY,
  new Map([[noDuration.id, { ...noDuration, assignmentKnown: false }]]),
);
check(
  "Missing duration does not invent an expected end",
  missingDurationEval.overlaps[0]?.id === "job-no-duration" &&
    missingDurationFacts[0]?.expectedEndLabel === null &&
    missingDurationFacts[0]?.scheduledStartLabel ===
      formatNextAvailableDateTime(noDuration.scheduledAt, NY),
);

const unassignedFacts = scheduleConflictFacts(
  [unassigned],
  NY,
  new Map([[unassigned.id, unassigned]]),
);
check(
  "Missing assignment remains truthful (Unassigned only when recorded)",
  unassignedFacts[0]?.customerName === "Customer" &&
    unassignedFacts[0]?.assignedWorkerName === "Unassigned",
);
const unknownAssignmentFacts = scheduleConflictFacts(
  [{ ...unassigned, assignmentKnown: false, assignedMembershipId: undefined }],
  NY,
  new Map([
    [
      unassigned.id,
      {
        ...unassigned,
        assignmentKnown: false,
        assignedMembershipId: undefined,
      },
    ],
  ]),
);
check(
  "Assignment is omitted when it is not recorded truth",
  unknownAssignmentFacts[0]?.assignedWorkerName === null,
);

const nyLabel = formatNextAvailableDateTime(alpha.scheduledAt, NY);
const laLabel = formatNextAvailableDateTime(alpha.scheduledAt, LA);
const nyFacts = scheduleConflictFacts(
  [alpha],
  NY,
  new Map([[alpha.id, { ...alpha, assignmentKnown: true }]]),
);
const laFacts = scheduleConflictFacts(
  [alpha],
  LA,
  new Map([[alpha.id, { ...alpha, assignmentKnown: true }]]),
);
check(
  "Conflict times use the Business timezone, not a host/browser default",
  nyFacts[0]?.scheduledStartLabel === nyLabel &&
    laFacts[0]?.scheduledStartLabel === laLabel &&
    nyLabel !== laLabel &&
    nyLabel.includes("8:00 AM") &&
    laLabel.includes("5:00 AM"),
);

const withDurationFacts = scheduleConflictFacts(
  [alpha],
  NY,
  new Map([[alpha.id, { ...alpha, assignmentKnown: true }]]),
);
check(
  "Recorded duration produces an expected end in the same Business timezone",
  withDurationFacts[0]?.expectedEndLabel ===
    formatNextAvailableDateTime(civil(2026, 9, 7, 9, 0), NY),
);

const clearEval = evaluateProposedSchedule({
  start: civil(2026, 9, 7, 15, 0),
  durationMinutes: 60,
  settings,
  existing: [alpha, bravo],
  timeZone: NY,
});
check(
  "A normal non-overlapping schedule has no overlap warning or conflict facts",
  clearEval.overlap == null &&
    clearEval.overlaps.length === 0 &&
    !hasScheduleWarning(clearEval) &&
    scheduleConflictFacts(clearEval.overlaps, NY, ownedTwo).length === 0,
);

console.log("\nUNIT — Schedule anyway and stale acknowledgement stay authoritative");

const ack = conflictAcknowledgement({
  jobId: "job-new",
  start: proposed,
  durationMinutes: 60,
  pickupMinutes: 0,
  assignedMembershipId: null,
  conflicts: [{ kind: "AVAILABILITY", jobId: "job-new", severity: "WARNING" }],
});
check(
  "Unacknowledged overlap still requires the existing warning path",
  shouldAcceptConflictAcknowledgement({
    submittedAck: "",
    currentAck: ack,
    conflicts: ["warning"],
  }) === "warn",
);
check(
  "Schedule anyway still requires the current explicit acknowledgement",
  shouldAcceptConflictAcknowledgement({
    submittedAck: ack,
    currentAck: ack,
    conflicts: ["warning"],
  }) === "accept",
);
const movedAck = conflictAcknowledgement({
  jobId: "job-new",
  start: civil(2026, 9, 7, 10, 0),
  durationMinutes: 60,
  pickupMinutes: 0,
  assignedMembershipId: null,
  conflicts: [{ kind: "AVAILABILITY", jobId: "job-new", severity: "WARNING" }],
});
check(
  "A stale acknowledgement is still rejected",
  ack !== movedAck &&
    shouldAcceptConflictAcknowledgement({
      submittedAck: ack,
      currentAck: movedAck,
      conflicts: ["warning"],
    }) === "warn",
);
check(
  "scheduleJob still gates the mutation on shouldAcceptConflictAcknowledgement === warn",
  /shouldAcceptConflictAcknowledgement\([\s\S]*?\) === "warn"/.test(scheduleJobSrc) &&
    /return \{[\s\S]*conflictAck: currentAck/.test(scheduleJobSrc),
);

console.log(
  failed === 0
    ? `\nAll schedule-conflict actionability checks passed (${passed}).`
    : `\n${failed} schedule-conflict actionability check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);

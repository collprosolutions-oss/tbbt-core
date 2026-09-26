/**
 * Appointment confirmation, property access, reschedule invalidation,
 * start-job override, and customer-portal security.
 *
 * Does not call Stripe or Resend.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-appointment-confirmation.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT,
  OWNER_DIFFERENT_TIME_ATTENTION_HEADING,
  OWNER_RECONFIRMATION_ATTENTION_HEADING,
  appointmentConfirmationLabel,
  customerAppointmentStatusLabel,
  customerNotificationNeeded,
  effectiveAppointmentConfirmationStatus,
  isCurrentAppointmentConfirmed,
  isMaterialAppointmentChange,
  nextAppointmentProposalId,
  ownerAppointmentAttention,
  parseAppointmentChangeRequestNote,
  startJobRequiresCustomerConfirmation,
} = await import("@/lib/appointment-confirmation");
const { ownerAccessSummaryLines, validateAccessArrangement } = await import("@/lib/property-access");
const {
  FOUNDER_TEST_CHANGE_REQUEST_NOTE,
  PROPERTY_ACCESS_COLUMN_KEYS,
  customerDifferentTimeRequestTouchesAccess,
  customerDifferentTimeRequestWriteData,
  isAppointmentChangeRequestSubmission,
  propertyAccessSnapshotsEqual,
  readAppointmentChangeRequestNoteFromFormData,
  snapshotPropertyAccess,
  withoutMisfiledChangeRequestAccess,
} = await import("@/lib/appointment-change-request");
const { ensureAppointmentConfirmationSchema } = await import("@/lib/appointment-data");
const { buildAppointmentProposedEmail } = await import("@/lib/appointment-mail");
const { evaluateStartJob } = await import("@/lib/job-lifecycle");
const { formatAppointmentWhen } = await import("@/lib/format");

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

const jobActionSrc = readRepo("src/app/actions/job.ts");
const publicSrc = readRepo("src/app/actions/public-appointment.ts");
const fieldSrc = readRepo("src/app/actions/field-job.ts");
const portalSrc = readRepo("src/app/p/[token]/page.tsx");
const portalActionsSrc = readRepo("src/components/portal/portal-appointment-actions.tsx");
const ownerJobSrc = readRepo("src/app/(app)/jobs/[jobId]/page.tsx");
const ownerBannerSrc = readRepo("src/components/jobs/owner-appointment-attention-banner.tsx");
const notifySrc = readRepo("src/lib/appointment-notify.ts");
const mailSrc = readRepo("src/lib/mail.ts");
const accessSrc = readRepo("src/lib/property-access.ts");

console.log("\nSTATIC — Security and lifecycle contracts");
check(
  "Customer mutations look up Job by projectToken only",
  publicSrc.includes("where: { projectToken: token }") &&
    !publicSrc.includes("formData.get(\"businessId\")") &&
    !publicSrc.includes("formData.get(\"jobId\")") &&
    !publicSrc.includes("formData.get(\"customerId\")"),
);
check(
  "Customer confirm cannot change Job.status or pricing",
  !publicSrc.includes('status: "IN_PROGRESS"') &&
    !publicSrc.includes("unitPrice") &&
    !publicSrc.includes("total:") &&
    publicSrc.includes("appointmentConfirmationStatus"),
);
check(
  "Field start has no owner override",
  fieldSrc.includes("CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT") &&
    !fieldSrc.includes("startWithoutConfirmation"),
);
check(
  "Owner start override requires OPERATE_JOBS path and a reason",
  jobActionSrc.includes("startWithoutConfirmation") &&
    jobActionSrc.includes("parseStartWithoutConfirmationReason"),
);
check(
  "Portal appointment actions stay on /p/{token}",
  portalSrc.includes("PortalAppointmentActions") &&
    portalSrc.includes("projectToken={token}"),
);
check(
  "Notification helper never interpolates access instructions into email input",
  !notifySrc.includes("propertyAccessInstructions") &&
    !notifySrc.includes("propertyAccessPickupLocation"),
);
check(
  "Appointment email still goes through getMailConfig + sendTransactionalEmail",
  notifySrc.includes("getMailConfig()") &&
    notifySrc.includes("sendTransactionalEmail({") &&
    mailSrc.includes("process.env.RESEND_API_KEY") &&
    mailSrc.includes("process.env.EMAIL_FROM"),
);
check(
  "Job.status values are not overloaded with CONFIRMED",
  !readRepo("prisma/schema.prisma").includes('status                    String    @default("CONFIRMED")') &&
    readRepo("prisma/schema.prisma").includes("appointmentConfirmationStatus"),
);
check(
  "Owner Work Order renders the amber appointment attention banner",
  ownerJobSrc.includes("OwnerAppointmentAttentionBanner") &&
    ownerBannerSrc.includes("AlertTriangle") &&
    ownerBannerSrc.includes("border-amber-300") &&
    ownerBannerSrc.includes("OWNER_DIFFERENT_TIME_ATTENTION_HEADING") &&
    ownerBannerSrc.includes("OWNER_RECONFIRMATION_ATTENTION_HEADING") &&
    !ownerBannerSrc.includes("variant=\"destructive\""),
);
check(
  "Customer portal does not use the owner attention banner",
  !portalSrc.includes("OwnerAppointmentAttentionBanner") &&
    !portalSrc.includes(OWNER_DIFFERENT_TIME_ATTENTION_HEADING) &&
    !portalSrc.includes(OWNER_RECONFIRMATION_ATTENTION_HEADING) &&
    portalSrc.includes("customerAppointmentStatusLabel") &&
    portalActionsSrc.includes("Confirm Appointment") &&
    portalActionsSrc.includes("Request Different Time") &&
    portalActionsSrc.includes("appointmentChangeRequestNote") &&
    portalActionsSrc.includes("request-different-time") &&
    portalSrc.includes("Change requested") &&
    portalSrc.includes("Your request:"),
);
check(
  "Portal confirm and request-different-time share one dispatched action",
  publicSrc.includes("submitCustomerAppointmentAction") &&
    publicSrc.includes("isAppointmentChangeRequestSubmission") &&
    portalActionsSrc.includes("submitCustomerAppointmentAction"),
);
check(
  "Different-time request stores a scheduling note, not access instructions",
  publicSrc.includes("customerDifferentTimeRequestWriteData") &&
    publicSrc.includes("data: write") &&
    publicSrc.includes("withoutMisfiledChangeRequestAccess") &&
    !publicSrc.includes("propertyAccessInstructions: note") &&
    !publicSrc.includes("propertyAccessNote: note"),
);
check(
  "Owner reschedule clears the scheduling note and does not null last confirmed proposal id",
  jobActionSrc.includes("appointmentChangeRequestNote: null") &&
    !jobActionSrc.includes("appointmentConfirmedForProposalId: null"),
);
check(
  "Access arrangement helper never copies a note into instructions",
  !accessSrc.includes("instructions ?? note"),
);
check(
  "Preview ensure repairs stale founder change-request text in access fields",
  readRepo("src/lib/appointment-data.ts").includes("repairMisfiledChangeRequestAccessFields") &&
    jobActionSrc.includes("withoutMisfiledChangeRequestAccess"),
);

const slot = {
  scheduledAt: new Date("2026-09-14T08:00:00"),
  scheduledDurationMinutes: 60,
  appointmentConfirmationStatus: "CONFIRMED",
  appointmentProposalId: 1,
  appointmentConfirmedForProposalId: 1,
  appointmentConfirmationSource: "PORTAL",
  propertyAccessMethod: "CUSTOMER_PRESENT",
  propertyAccessInstructions: null,
  propertyAccessContactName: null,
  propertyAccessContactInfo: null,
  propertyAccessPickupLocation: null,
  propertyAccessNote: null,
};

function accessJob(extras = {}) {
  return {
    propertyAccessMethod: extras.propertyAccessMethod ?? null,
    propertyAccessInstructions: extras.propertyAccessInstructions ?? null,
    propertyAccessContactName: extras.propertyAccessContactName ?? null,
    propertyAccessContactInfo: extras.propertyAccessContactInfo ?? null,
    propertyAccessPickupLocation: extras.propertyAccessPickupLocation ?? null,
    propertyAccessNote: extras.propertyAccessNote ?? null,
  };
}

console.log("\nPURE — Confirmation binding and access completeness");
check("Confirmed current slot is customer-confirmed", isCurrentAppointmentConfirmed(slot));
check(
  "Rescheduled slot is not confirmed",
  !isCurrentAppointmentConfirmed({
    ...slot,
    appointmentProposalId: 2,
    scheduledAt: new Date("2026-09-15T08:00:00"),
  }),
);
check(
  "Confirmed without required access is not fully confirmed",
  !isCurrentAppointmentConfirmed({
    ...slot,
    propertyAccessMethod: "ACCESS_CODE",
    propertyAccessInstructions: null,
  }),
);
check(
  "Scheduled without confirmation is awaiting",
  effectiveAppointmentConfirmationStatus({
    ...slot,
    appointmentConfirmationStatus: "AWAITING_CUSTOMER",
    appointmentConfirmedForProposalId: null,
    propertyAccessMethod: null,
  }) === "AWAITING_CUSTOMER",
);
check(
  "Different time requested stays distinguishable",
  effectiveAppointmentConfirmationStatus({
    ...slot,
    appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED",
    appointmentConfirmedForProposalId: null,
    propertyAccessMethod: null,
  }) === "DIFFERENT_TIME_REQUESTED",
);
check(
  "Awaiting label is Awaiting Customer Confirmation",
  appointmentConfirmationLabel("AWAITING_CUSTOMER") ===
    "Awaiting Customer Confirmation",
);
check(
  "Confirmed label is Customer Confirmed",
  appointmentConfirmationLabel("CONFIRMED") === "Customer Confirmed",
);
check(
  "Owner attention headings match founder copy",
  OWNER_DIFFERENT_TIME_ATTENTION_HEADING === "CUSTOMER REQUEST / APPOINTMENT CHANGE" &&
    OWNER_RECONFIRMATION_ATTENTION_HEADING ===
      "APPOINTMENT CHANGED — CUSTOMER RECONFIRMATION REQUIRED",
);
check(
  "Customer portal awaiting copy is Awaiting Your Confirmation",
  customerAppointmentStatusLabel("AWAITING_CUSTOMER") ===
    "Awaiting Your Confirmation",
);
check(
  "Different-time request produces owner attention",
  ownerAppointmentAttention({
    ...slot,
    appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED",
    appointmentConfirmedForProposalId: null,
    propertyAccessMethod: null,
    appointmentChangeRequestNote: "Available Wednesday instead.",
  }) === "DIFFERENT_TIME",
);
check(
  "First schedule without confirmation has no owner attention banner",
  ownerAppointmentAttention({
    ...slot,
    appointmentConfirmationStatus: "AWAITING_CUSTOMER",
    appointmentConfirmedForProposalId: null,
    propertyAccessMethod: null,
  }) === null,
);
check(
  "Reschedule of a previously confirmed appointment requires reconfirmation attention",
  ownerAppointmentAttention({
    ...slot,
    appointmentConfirmationStatus: "AWAITING_CUSTOMER",
    appointmentProposalId: 2,
    appointmentConfirmedForProposalId: 1,
    propertyAccessMethod: "CUSTOMER_PRESENT",
  }) === "RECONFIRMATION",
);
check(
  "Customer reconfirmation clears owner attention",
  ownerAppointmentAttention({
    ...slot,
    appointmentConfirmationStatus: "CONFIRMED",
    appointmentProposalId: 2,
    appointmentConfirmedForProposalId: 2,
  }) === null,
);
check(
  "Change-request note is trimmed and capped",
  parseAppointmentChangeRequestNote("  Available Wednesday instead.  ") ===
    "Available Wednesday instead.",
);
check(
  "Confirmed slot with a current-proposal change request is not Customer Confirmed",
  !isCurrentAppointmentConfirmed({
    ...slot,
    appointmentChangeRequestNote: "make it 9am instead",
  }) &&
    effectiveAppointmentConfirmationStatus({
      ...slot,
      appointmentChangeRequestNote: "make it 9am instead",
    }) === "DIFFERENT_TIME_REQUESTED" &&
    ownerAppointmentAttention({
      ...slot,
      appointmentChangeRequestNote: "make it 9am instead",
    }) === "DIFFERENT_TIME",
);

const changeRequestForm = new FormData();
changeRequestForm.set("appointmentAction", "request-different-time");
changeRequestForm.set("appointmentChangeRequestNote", "make it 9am instead");
changeRequestForm.set("accessInstructions", "make it 9am instead");
changeRequestForm.set("accessNote", "make it 9am instead");
changeRequestForm.set("accessMethod", "ACCESS_CODE");
check(
  "Request Different Time FormData is classified as a change request even if access fields are also present",
  isAppointmentChangeRequestSubmission(changeRequestForm),
);
check(
  "Change-request note is read from the dedicated field, not accessInstructions",
  readAppointmentChangeRequestNoteFromFormData(changeRequestForm) ===
    "make it 9am instead",
);
const changeRequestWrite = customerDifferentTimeRequestWriteData(
  readAppointmentChangeRequestNoteFromFormData(changeRequestForm),
);
check(
  "Different-time write data stores the exact founder note",
  changeRequestWrite.appointmentChangeRequestNote === "make it 9am instead" &&
    changeRequestWrite.appointmentConfirmationStatus === "DIFFERENT_TIME_REQUESTED",
);
check(
  "Different-time write data does not include any access fields",
  !customerDifferentTimeRequestTouchesAccess(changeRequestWrite) &&
    PROPERTY_ACCESS_COLUMN_KEYS.every((key) => !(key in changeRequestWrite)) &&
    changeRequestWrite.propertyAccessInstructions !== FOUNDER_TEST_CHANGE_REQUEST_NOTE,
);
const sanitizedConfirmAccess = withoutMisfiledChangeRequestAccess(
  {
    method: "ACCESS_CODE",
    instructions: FOUNDER_TEST_CHANGE_REQUEST_NOTE,
    contactName: null,
    contactInfo: null,
    pickupLocation: null,
    note: FOUNDER_TEST_CHANGE_REQUEST_NOTE,
  },
  { appointmentChangeRequestNote: FOUNDER_TEST_CHANGE_REQUEST_NOTE },
);
check(
  "Confirm/reconfirm cannot persist the founder change-request note as access",
  sanitizedConfirmAccess.instructions !== FOUNDER_TEST_CHANGE_REQUEST_NOTE &&
    sanitizedConfirmAccess.note !== FOUNDER_TEST_CHANGE_REQUEST_NOTE &&
    sanitizedConfirmAccess.method === "CUSTOMER_PRESENT",
);
const poisonedAccessLines = ownerAccessSummaryLines({
  propertyAccessMethod: "ACCESS_CODE",
  propertyAccessInstructions: "make it 9am instead",
  propertyAccessContactName: null,
  propertyAccessContactInfo: null,
  propertyAccessPickupLocation: null,
  propertyAccessNote: null,
  appointmentChangeRequestNote: "make it 9am instead",
});
check(
  "Owner access summary does not render the founder note as Access instructions",
  !poisonedAccessLines.some((line) =>
    line.toLowerCase().includes("access instructions: make it 9am instead"),
  ),
);
check(
  "Appointment when format uses at, not a comma-only datetime",
  formatAppointmentWhen(slot.scheduledAt).includes(" at ") &&
    formatAppointmentWhen(slot.scheduledAt).includes("2026"),
);
check(
  "Material date change is a new proposal",
  isMaterialAppointmentChange(slot, new Date("2026-09-15T08:00:00"), 60),
);
check(
  "Same slot is not a material change",
  !isMaterialAppointmentChange(slot, slot.scheduledAt, 60),
);
check("Proposal ids increment", nextAppointmentProposalId(1) === 2);
check(
  "Start requires confirmation when awaiting",
  startJobRequiresCustomerConfirmation({
    ...slot,
    appointmentConfirmationStatus: "AWAITING_CUSTOMER",
    appointmentConfirmedForProposalId: null,
    propertyAccessMethod: null,
  }),
);
check(
  "evaluateStartJob still only speaks Job.status",
  evaluateStartJob("SCHEDULED").nextStatus === "IN_PROGRESS",
);
check(
  "Unconfirmed start message is founder-specified",
  CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT ===
    "Customer has not confirmed this appointment.",
);
check(
  "Notification is needed when never sent for this proposal",
  customerNotificationNeeded({
    scheduledAt: slot.scheduledAt,
    appointmentProposalId: 1,
    appointmentNotificationStatus: "FAILED",
    appointmentNotifiedForProposalId: 1,
  }),
);

console.log("\nPURE — Access methods");
const methods = [
  ["CUSTOMER_PRESENT", {}, true],
  ["CONTRACTOR_HAS_KEY", {}, true],
  ["EXTERIOR_NO_ENTRY", {}, true],
  ["KEY_AT_PROPERTY", {}, false],
  ["KEY_AT_PROPERTY", { instructions: "Lockbox beside garage" }, true],
  ["ACCESS_CODE", {}, false],
  ["ACCESS_CODE", { instructions: "Gate 4455 then door 2211" }, true],
  ["OTHER", {}, false],
  ["OTHER", { instructions: "Neighbor will meet you" }, true],
  ["KEY_PICKUP_REQUIRED", {}, false],
  ["KEY_PICKUP_REQUIRED", { pickupLocation: "Office at 1 Main St" }, true],
  ["OTHER_PERSON_PRESENT", {}, true],
];
for (const [method, extra, expectedOk] of methods) {
  const result = validateAccessArrangement({ method, ...extra });
  check(`${method} ${expectedOk ? "accepts" : "requires"} extra fields as specified`, result.ok === expectedOk);
}

const schedulingNoteAccess = validateAccessArrangement({
  method: "CUSTOMER_PRESENT",
  note: "available wednesday instead",
});
check(
  "Optional access note is not stored as access instructions",
  schedulingNoteAccess.ok &&
    schedulingNoteAccess.value.instructions == null &&
    schedulingNoteAccess.value.note === "available wednesday instead",
);
const accessLinesFromNote = ownerAccessSummaryLines(
  accessJob({
    propertyAccessMethod: "CUSTOMER_PRESENT",
    propertyAccessInstructions: schedulingNoteAccess.value.instructions,
    propertyAccessNote: schedulingNoteAccess.value.note,
  }),
);
check(
  "Owner access summary does not present a scheduling note as Access instructions",
  accessLinesFromNote.every(
    (line) => !line.toLowerCase().startsWith("access instructions:"),
  ) &&
    !accessLinesFromNote.some((line) =>
      line.toLowerCase().includes("access instructions: available wednesday instead"),
    ),
);
const schedulingRequestLines = ownerAccessSummaryLines(
  accessJob({
    propertyAccessMethod: "KEY_AT_PROPERTY",
    propertyAccessInstructions: "Lockbox beside garage",
  }),
);
check(
  "Real access instructions remain labeled as access instructions",
  schedulingRequestLines.some((line) => line === "Access instructions: Lockbox beside garage"),
);
check(
  "Scheduling-request data stays off the access summary",
  !schedulingRequestLines.some((line) => line.toLowerCase().includes("wednesday")),
);

const email = buildAppointmentProposedEmail({
  businessName: "CollPro Reno",
  customerName: "Stanley",
  address: "12 Test St, Reno, NV 89501",
  scheduledAt: slot.scheduledAt,
  scheduledDurationMinutes: 60,
  serviceDescription: "Ceiling Fan Replacement",
  projectUrl: "https://www.collproreno.com/p/stanley-token",
  rescheduled: false,
  timeZone: "America/New_York",
});
check("Email names the business and customer", email.text.includes("CollPro Reno") && email.text.includes("Stanley"));
check("Email includes service address and service description", email.text.includes("12 Test St") && email.text.includes("Ceiling Fan Replacement"));
check("Email primary/secondary/view actions use the portal URL", email.html.includes("https://www.collproreno.com/p/stanley-token"));
check("Email omits owner routes", !email.html.includes("/jobs/") && !email.text.includes("/admin"));

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.log("\nDB skipped — DATABASE_URL is not set");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

const testDbName = "tbbt_appointment_confirmation_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for appointment-confirmation test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

async function makeBusiness(slug) {
  return prisma.business.create({
    data: { name: `Biz ${slug}`, slug, tradeCode: "HANDYMAN" },
  });
}

async function makeJob(businessId, extras = {}) {
  const customer = await prisma.customer.create({
    data: {
      businessId,
      name: extras.customerName ?? "Stanley",
      email: extras.email ?? "stanley@example.com",
    },
  });
  const property = await prisma.property.create({
    data: {
      businessId,
      customerId: customer.id,
      addressLine1: extras.address ?? "12 Test St",
      city: "Reno",
      region: "NV",
      postalCode: "89501",
    },
  });
  return prisma.job.create({
    data: {
      businessId,
      customerId: customer.id,
      propertyId: property.id,
      projectToken: extras.projectToken ?? randomUUID(),
      status: extras.status ?? "UNSCHEDULED",
      scheduledAt: extras.scheduledAt ?? null,
      scheduledDurationMinutes: extras.scheduledDurationMinutes ?? null,
      appointmentProposalId: extras.appointmentProposalId ?? 0,
      appointmentConfirmationStatus: extras.appointmentConfirmationStatus ?? "NONE",
      ...extras.job,
    },
  });
}

function sameSlot(job, start, minutes) {
  return (
    job.scheduledAt?.getTime() === start.getTime() &&
    (job.scheduledDurationMinutes ?? null) === (minutes ?? null)
  );
}

async function proposeAppointment(job, start, minutes) {
  const materialChange = isMaterialAppointmentChange(job, start, minutes);
  const proposalId = materialChange
    ? nextAppointmentProposalId(job.appointmentProposalId)
    : job.appointmentProposalId;
  const updated = await prisma.job.update({
    where: { id: job.id },
    data: {
      scheduledAt: start,
      scheduledDurationMinutes: minutes,
      ...(job.status === "UNSCHEDULED" ? { status: "SCHEDULED" } : {}),
      ...(materialChange
        ? {
            appointmentProposalId: proposalId,
            appointmentConfirmationStatus: "AWAITING_CUSTOMER",
            appointmentConfirmedAt: null,
            appointmentConfirmationSource: null,
            appointmentConfirmedByMembershipId: null,
            appointmentChangeRequestNote: null,
            appointmentNotificationStatus: "FAILED",
            appointmentNotificationError: "The appointment email could not be sent.",
            appointmentNotifiedForProposalId: proposalId,
          }
        : {}),
    },
  });
  if (materialChange) {
    await prisma.jobAppointmentEvent.create({
      data: {
        businessId: job.businessId,
        jobId: job.id,
        eventType: job.scheduledAt ? "APPOINTMENT_RESCHEDULED" : "APPOINTMENT_PROPOSED",
        appointmentProposalId: proposalId,
        scheduledAt: start,
        scheduledDurationMinutes: minutes,
        actorKind: "OWNER",
      },
    });
  }
  return { job: updated, materialChange, proposalId, sameSlot: sameSlot(job, start, minutes) };
}

try {
  console.log("\nDB — Propose, confirm, access, reschedule, security");
  const businessA = await makeBusiness(`appt-a-${randomUUID().slice(0, 8)}`);
  const businessB = await makeBusiness(`appt-b-${randomUUID().slice(0, 8)}`);
  const start = new Date(2026, 8, 14, 8, 0, 0);
  const job = await makeJob(businessA.id);
  const first = await proposeAppointment(job, start, 60);
  check("First schedule persists scheduledAt even if notification is marked failed", first.job.scheduledAt.getTime() === start.getTime());
  check("First schedule is awaiting customer confirmation", first.job.appointmentConfirmationStatus === "AWAITING_CUSTOMER");
  check("Failed notification does not roll back the appointment", first.job.appointmentNotificationStatus === "FAILED");
  check("Job operational status is SCHEDULED, not CONFIRMED", first.job.status === "SCHEDULED");

  const token = first.job.projectToken;
  const other = await makeJob(businessB.id, { projectToken: randomUUID() });
  await proposeAppointment(other, start, 60);

  const missingAccess = validateAccessArrangement({ method: "ACCESS_CODE" });
  check("ACCESS_CODE cannot confirm without instructions", missingAccess.ok === false);

  const access = validateAccessArrangement({
    method: "KEY_AT_PROPERTY",
    instructions: "Key inside lockbox beside garage",
  });
  check("KEY_AT_PROPERTY accepts a key location", access.ok === true);

  const confirmed = await prisma.job.updateMany({
    where: {
      projectToken: token,
      appointmentProposalId: first.proposalId,
      appointmentConfirmationStatus: { in: ["NONE", "AWAITING_CUSTOMER", "DIFFERENT_TIME_REQUESTED"] },
    },
    data: {
      appointmentConfirmationStatus: "CONFIRMED",
      appointmentConfirmedAt: new Date(),
      appointmentConfirmedForProposalId: first.proposalId,
      appointmentConfirmationSource: "PORTAL",
      propertyAccessMethod: access.value.method,
      propertyAccessInstructions: access.value.instructions,
    },
  });
  check("Confirm by token updates exactly one job", confirmed.count === 1);
  const afterConfirm = await prisma.job.findUnique({ where: { projectToken: token } });
  check("Portal confirmation is Customer Confirmed for this proposal", isCurrentAppointmentConfirmed(afterConfirm));
  check("Access instructions are stored on the Job, not emailed", afterConfirm.propertyAccessInstructions.includes("lockbox"));

  const secondConfirm = await prisma.job.updateMany({
    where: {
      projectToken: token,
      appointmentProposalId: first.proposalId,
      appointmentConfirmationStatus: { in: ["NONE", "AWAITING_CUSTOMER", "DIFFERENT_TIME_REQUESTED"] },
    },
    data: { appointmentConfirmationStatus: "CONFIRMED" },
  });
  check("Second confirm is idempotent (no second write)", secondConfirm.count === 0);
  check(
    "Idempotent confirm still reads as confirmed",
    isCurrentAppointmentConfirmed(await prisma.job.findUnique({ where: { projectToken: token } })),
  );

  const cross = await prisma.job.updateMany({
    where: {
      projectToken: other.projectToken,
      id: first.job.id,
    },
    data: { appointmentConfirmationStatus: "CONFIRMED" },
  });
  check("Cross-token / cross-job confirm updates nothing", cross.count === 0);

  const later = new Date(2026, 8, 15, 9, 0, 0);
  const rescheduled = await proposeAppointment(afterConfirm, later, 90);
  check("Reschedule keeps the original access instructions", rescheduled.job.propertyAccessInstructions.includes("lockbox"));
  check("Reschedule is awaiting confirmation again", rescheduled.job.appointmentConfirmationStatus === "AWAITING_CUSTOMER");
  check("Stale confirmation does not apply to the new slot", !isCurrentAppointmentConfirmed(rescheduled.job));
  check("Proposal id advanced", rescheduled.proposalId === first.proposalId + 1);
  check(
    "Reschedule of a confirmed appointment keeps the last confirmed proposal id as a stale binding",
    rescheduled.job.appointmentConfirmedForProposalId === first.proposalId &&
      ownerAppointmentAttention(rescheduled.job) === "RECONFIRMATION",
  );

  const staleConfirm = await prisma.job.updateMany({
    where: {
      projectToken: token,
      appointmentProposalId: first.proposalId,
    },
    data: { appointmentConfirmationStatus: "CONFIRMED" },
  });
  check("Stale proposal confirm cannot match the current proposal id", staleConfirm.count === 0);

  const reconfirm = validateAccessArrangement({
    method: "KEY_AT_PROPERTY",
    instructions: "Key under rear lanai cabinet",
  });
  await prisma.job.update({
    where: { id: first.job.id },
    data: {
      appointmentConfirmationStatus: "CONFIRMED",
      appointmentConfirmedForProposalId: rescheduled.proposalId,
      appointmentConfirmationSource: "PORTAL",
      propertyAccessMethod: reconfirm.value.method,
      propertyAccessInstructions: reconfirm.value.instructions,
    },
  });
  const afterReconfirm = await prisma.job.findUnique({ where: { id: first.job.id } });
  check("Customer can update access when reconfirming", afterReconfirm.propertyAccessInstructions.includes("lanai"));
  check("Reconfirm is bound to the new proposal", isCurrentAppointmentConfirmed(afterReconfirm));
  check("Customer reconfirmation clears owner attention", ownerAppointmentAttention(afterReconfirm) === null);

  const awaiting = await makeJob(businessA.id, {
    status: "SCHEDULED",
    scheduledAt: start,
    scheduledDurationMinutes: 60,
    appointmentProposalId: 1,
    appointmentConfirmationStatus: "AWAITING_CUSTOMER",
  });
  const different = await prisma.job.update({
    where: { id: awaiting.id },
    data: {
      appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED",
      appointmentConfirmedAt: null,
      appointmentChangeRequestNote: "available wednesday instead",
    },
  });
  check("Request different time preserves the proposed appointment", different.scheduledAt.getTime() === start.getTime());
  check(
    "Request different time is not confirmed",
    effectiveAppointmentConfirmationStatus(different) === "DIFFERENT_TIME_REQUESTED" &&
      !isCurrentAppointmentConfirmed(different),
  );
  check(
    "Different-time request produces owner attention",
    ownerAppointmentAttention(different) === "DIFFERENT_TIME",
  );
  check(
    "Customer scheduling note is not stored as access instructions",
    different.appointmentChangeRequestNote === "available wednesday instead" &&
      different.propertyAccessInstructions == null &&
      different.propertyAccessNote == null,
  );
  const differentAccessLines = ownerAccessSummaryLines(different);
  check(
    "Owner access summary does not render the scheduling note as Access instructions",
    !differentAccessLines.some((line) =>
      line.toLowerCase().includes("available wednesday instead"),
    ),
  );

  const founderNote = "make it 9am instead";
  const founderConfirmed = await makeJob(businessA.id, {
    status: "SCHEDULED",
    scheduledAt: new Date(2026, 8, 16, 8, 0, 0),
    scheduledDurationMinutes: 60,
    appointmentProposalId: 1,
    appointmentConfirmationStatus: "CONFIRMED",
    job: {
      appointmentConfirmedForProposalId: 1,
      propertyAccessMethod: "ACCESS_CODE",
      propertyAccessInstructions: "Gate 4455 then door 2211",
    },
  });
  const founderWrite = customerDifferentTimeRequestWriteData(founderNote);
  const accessBeforeFounderRequest = snapshotPropertyAccess(founderConfirmed);
  check(
    "Founder note write payload does not contain accessInstructions",
    founderWrite.appointmentChangeRequestNote === founderNote &&
      !customerDifferentTimeRequestTouchesAccess(founderWrite) &&
      PROPERTY_ACCESS_COLUMN_KEYS.every((key) => !(key in founderWrite)),
  );
  const afterFounderRequest = await prisma.job.update({
    where: { id: founderConfirmed.id },
    data: founderWrite,
  });
  check(
    "After Request Different Time the founder note is only in appointmentChangeRequestNote",
    afterFounderRequest.appointmentChangeRequestNote === founderNote &&
      afterFounderRequest.propertyAccessInstructions !== founderNote &&
      afterFounderRequest.propertyAccessInstructions === "Gate 4455 then door 2211" &&
      afterFounderRequest.appointmentConfirmationStatus === "DIFFERENT_TIME_REQUESTED",
  );
  check(
    "Request Different Time never modifies any propertyAccess field",
    propertyAccessSnapshotsEqual(
      accessBeforeFounderRequest,
      snapshotPropertyAccess(afterFounderRequest),
    ),
  );

  const poisonedStanley = await makeJob(businessA.id, {
    status: "SCHEDULED",
    scheduledAt: new Date(2026, 8, 16, 9, 0, 0),
    scheduledDurationMinutes: 60,
    appointmentProposalId: 2,
    appointmentConfirmationStatus: "CONFIRMED",
    job: {
      appointmentConfirmedForProposalId: 2,
      appointmentChangeRequestNote: null,
      propertyAccessMethod: "ACCESS_CODE",
      propertyAccessInstructions: FOUNDER_TEST_CHANGE_REQUEST_NOTE,
      propertyAccessNote: FOUNDER_TEST_CHANGE_REQUEST_NOTE,
    },
  });
  await ensureAppointmentConfirmationSchema(prisma);
  const cleanedStanley = await prisma.job.findUnique({
    where: { id: poisonedStanley.id },
  });
  check(
    "Stale founder note is cleared from property-access fields only",
    cleanedStanley?.propertyAccessInstructions !== FOUNDER_TEST_CHANGE_REQUEST_NOTE &&
      cleanedStanley?.propertyAccessNote !== FOUNDER_TEST_CHANGE_REQUEST_NOTE &&
      cleanedStanley?.propertyAccessMethod === "CUSTOMER_PRESENT" &&
      cleanedStanley?.appointmentChangeRequestNote == null &&
      cleanedStanley?.appointmentConfirmationStatus === "CONFIRMED" &&
      cleanedStanley?.appointmentProposalId === 2,
  );
  check(
    "After Request Different Time the owner attention banner is CUSTOMER REQUEST",
    ownerAppointmentAttention(afterFounderRequest) === "DIFFERENT_TIME" &&
      !isCurrentAppointmentConfirmed(afterFounderRequest),
  );
  const founderAccessLines = ownerAccessSummaryLines(afterFounderRequest);
  check(
    "After Request Different Time access instructions stay the real gate code",
    founderAccessLines.includes("Access instructions: Gate 4455 then door 2211") &&
      !founderAccessLines.some((line) => line.includes(founderNote)),
  );

  const confirmedThenRequest = await makeJob(businessA.id, {
    status: "SCHEDULED",
    scheduledAt: start,
    scheduledDurationMinutes: 60,
    appointmentProposalId: 1,
    appointmentConfirmationStatus: "CONFIRMED",
    job: {
      appointmentConfirmedForProposalId: 1,
      propertyAccessMethod: "CUSTOMER_PRESENT",
      propertyAccessInstructions: "Lockbox beside garage",
    },
  });
  const requestedAfterConfirm = await prisma.job.update({
    where: { id: confirmedThenRequest.id },
    data: {
      appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED",
      appointmentConfirmedAt: null,
      appointmentConfirmationSource: null,
      appointmentChangeRequestNote: "Available Wednesday instead.",
    },
  });
  check(
    "Different-time after confirm keeps access data and last confirmed proposal id",
    requestedAfterConfirm.appointmentConfirmedForProposalId === 1 &&
      requestedAfterConfirm.propertyAccessInstructions === "Lockbox beside garage" &&
      requestedAfterConfirm.appointmentChangeRequestNote === "Available Wednesday instead." &&
      ownerAppointmentAttention(requestedAfterConfirm) === "DIFFERENT_TIME",
  );
  const wednesday = new Date(2026, 8, 16, 8, 0, 0);
  const afterOwnerReschedule = await proposeAppointment(requestedAfterConfirm, wednesday, 60);
  check(
    "Owner reschedule after a confirmed slot shows reconfirmation attention",
    afterOwnerReschedule.job.appointmentConfirmationStatus === "AWAITING_CUSTOMER" &&
      afterOwnerReschedule.job.appointmentChangeRequestNote == null &&
      afterOwnerReschedule.job.propertyAccessInstructions === "Lockbox beside garage" &&
      afterOwnerReschedule.job.appointmentConfirmedForProposalId === 1 &&
      ownerAppointmentAttention(afterOwnerReschedule.job) === "RECONFIRMATION" &&
      !isCurrentAppointmentConfirmed(afterOwnerReschedule.job),
  );
  const accessStillSeparate = ownerAccessSummaryLines(afterOwnerReschedule.job);
  check(
    "Access data and scheduling-request data remain separate after reschedule",
    accessStillSeparate.some((line) => line === "Access instructions: Lockbox beside garage") &&
      !accessStillSeparate.some((line) => line.toLowerCase().includes("wednesday")) &&
      afterOwnerReschedule.job.appointmentChangeRequestNote == null,
  );

  const ownerManual = await makeJob(businessA.id, {
    status: "SCHEDULED",
    scheduledAt: start,
    scheduledDurationMinutes: 60,
    appointmentProposalId: 1,
    appointmentConfirmationStatus: "AWAITING_CUSTOMER",
  });
  const membership = await prisma.user.create({
    data: {
      name: "Owner",
      email: `owner-${randomUUID()}@example.com`,
      passwordHash: "x",
      memberships: { create: { businessId: businessA.id, role: "OWNER" } },
    },
    include: { memberships: true },
  });
  const recorded = await prisma.job.update({
    where: { id: ownerManual.id },
    data: {
      appointmentConfirmationStatus: "CONFIRMED",
      appointmentConfirmedAt: new Date(),
      appointmentConfirmedForProposalId: 1,
      appointmentConfirmationSource: "OWNER_PHONE",
      appointmentConfirmedByMembershipId: membership.memberships[0].id,
      propertyAccessMethod: "CUSTOMER_PRESENT",
    },
  });
  check("Owner-recorded confirmation is not a portal confirmation", recorded.appointmentConfirmationSource === "OWNER_PHONE");
  check("Owner-recorded confirmation counts for Start Job", isCurrentAppointmentConfirmed(recorded));

  const overrideJob = await makeJob(businessA.id, {
    status: "SCHEDULED",
    scheduledAt: start,
    scheduledDurationMinutes: 60,
    appointmentProposalId: 1,
    appointmentConfirmationStatus: "AWAITING_CUSTOMER",
  });
  check("Unconfirmed appointment blocks normal start", startJobRequiresCustomerConfirmation(overrideJob));
  const started = await prisma.job.update({
    where: { id: overrideJob.id },
    data: {
      status: "IN_PROGRESS",
      startWithoutConfirmationAt: new Date(),
      startWithoutConfirmationReason: "Confirmed by phone",
      startWithoutConfirmationByMembershipId: membership.memberships[0].id,
    },
  });
  check("Override can start the job without marking it customer-confirmed", started.status === "IN_PROGRESS" && !isCurrentAppointmentConfirmed(started));

  const pickup = validateAccessArrangement({
    method: "KEY_PICKUP_REQUIRED",
    pickupLocation: "123 Pickup Rd, Reno NV",
    contactName: "Office",
    contactInfo: "775-000-0000",
    instructions: "Ask for the spare key",
  });
  check("KEY_PICKUP_REQUIRED stores a structured pickup location", pickup.ok && pickup.value.pickupLocation === "123 Pickup Rd, Reno NV");

  const events = await prisma.jobAppointmentEvent.findMany({ where: { jobId: first.job.id } });
  check(
    "Appointment events were recorded for propose/reschedule",
    events.some((event) => event.eventType === "APPOINTMENT_PROPOSED") &&
      events.some((event) => event.eventType === "APPOINTMENT_RESCHEDULED"),
  );
  check(
    "Appointment events do not store key-location instructions",
    events.every((event) => !(event.payload ?? "").includes("lockbox") && !(event.payload ?? "").includes("lanai")),
  );
} finally {
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

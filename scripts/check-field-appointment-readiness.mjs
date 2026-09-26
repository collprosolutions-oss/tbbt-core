/**
 * Field appointment-readiness + arrival-window truth.
 *
 * Assignment and scheduling stay separate. The assigned worker must see:
 *   1. Job has not been scheduled yet
 *   2. Job is scheduled but customer confirmation/access is incomplete
 *   3. Job is scheduled with an arrival window
 *   4. Job is scheduled at an exact appointment time
 *   5. Job is ready to Start
 *
 * Does not change scheduling, confirmation, authorization, or lifecycle
 * rules. Owned production files only:
 *   src/app/field/jobs/[jobId]/page.tsx
 *   src/components/field/start-assigned-job-button.tsx
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-field-appointment-readiness.mjs
 */
import { createRequire, register } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { formatDateTime, formatTime } = await import("@/lib/format");
const { resolveBusinessTimeZone } = await import("@/lib/business-timezone");
const { isCurrentAppointmentConfirmed } = await import(
  "@/lib/appointment-confirmation"
);

/** Mirrors assignedJobWhere() in src/lib/field-access.ts. Not imported from
 *  that module because it pulls next/navigation into this Node script. */
function assignedJobWhere(jobId, field) {
  return {
    id: jobId,
    businessId: field.businessId,
    assignedMembershipId: field.membershipId,
  };
}

const WAITING_FOR_OFFICE = "Waiting for the office to schedule this job.";
const CUSTOMER_NOT_CONFIRMED = "Customer has not confirmed this appointment.";
const ACCESS_INSTRUCTIONS = "Key is under the back-porch mat.";

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function windowEnd(scheduledAt, arrivalWindowMinutes) {
  return new Date(scheduledAt.getTime() + arrivalWindowMinutes * 60 * 1000);
}

function arrivalWindowCopy(scheduledAt, arrivalWindowMinutes, timeZone) {
  return `Arrival window: ${formatDateTime(scheduledAt, timeZone)} – ${formatTime(
    windowEnd(scheduledAt, arrivalWindowMinutes),
    timeZone,
  )}`;
}

function exactAppointmentCopy(scheduledAt, timeZone) {
  return `Appointment time: ${formatDateTime(scheduledAt, timeZone)}`;
}

function hasStartJobSubmit(body) {
  return /<button\b[^>]*>\s*Start Job\s*<\/button>/i.test(body);
}

function hasCompleteJobSubmit(body) {
  return /<button\b[^>]*>\s*Complete Job\s*<\/button>/i.test(body);
}

const fieldPageSrc = readRepo("src/app/field/jobs/[jobId]/page.tsx");
const startButtonSrc = readRepo("src/components/field/start-assigned-job-button.tsx");
const fieldActionSrc = readRepo("src/app/actions/field-job.ts");
const completeButtonSrc = readRepo("src/components/field/complete-assigned-job-button.tsx");
const fieldAccessSrc = readRepo("src/lib/field-access.ts");
const timeCardOpsSrc = readRepo("src/lib/time-card-ops.ts");

const jobSelectMatch = fieldPageSrc.match(
  /const job = await prisma\.job\.findFirst\(\{[\s\S]*?\n  \}\);/,
);
const jobSelectSrc = jobSelectMatch?.[0] ?? "";

console.log("\nSTATIC — Owned Field page loads persisted arrival-window truth");
check(
  "Field Job page has exactly one assignment-scoped Job findFirst",
  (fieldPageSrc.match(/prisma\.job\.findFirst/g) ?? []).length === 1,
);
check(
  "That Job select includes arrivalWindowMinutes on the existing query",
  jobSelectSrc.includes("arrivalWindowMinutes: true") &&
    jobSelectSrc.includes("where: assignedJobWhere(jobId, field)"),
);
check(
  "No second Job query and no business-wide schedule import",
  !fieldPageSrc.includes("prisma.job.findMany") &&
    !fieldPageSrc.includes('from "@/lib/schedule"') &&
    !fieldPageSrc.includes("groupJobsByDay") &&
    !fieldPageSrc.includes("loadAvailabilitySnapshot") &&
    !fieldPageSrc.includes("defaultArrivalWindowMinutes"),
);
check(
  "Arrival window end is scheduledAt + recorded arrivalWindowMinutes",
  fieldPageSrc.includes("Arrival window:") &&
    fieldPageSrc.includes("job.arrivalWindowMinutes * 60 * 1000") &&
    fieldPageSrc.includes("formatDateTime(job.scheduledAt, timeZone)") &&
    fieldPageSrc.includes("formatTime(") &&
    jobSelectSrc.includes("scheduledDurationMinutes: true"),
);
check(
  "Exact-time jobs are labeled as an appointment time, not a window",
  fieldPageSrc.includes("Appointment time: ${formatDateTime(job.scheduledAt, timeZone)}") &&
    fieldPageSrc.includes("job.arrivalWindowMinutes && job.arrivalWindowMinutes > 0"),
);
check(
  "Page still binds Business.timezone already resolved on the Field page",
  fieldPageSrc.includes("resolveBusinessTimeZone(field.workspace.business)") &&
    fieldPageSrc.includes("formatDateTime(job.scheduledAt, timeZone)"),
);

console.log("\nSTATIC — Readiness states stay distinct");
check(
  "Unscheduled assigned jobs show the office-scheduling wait copy",
  startButtonSrc.includes(WAITING_FOR_OFFICE) &&
    startButtonSrc.includes("if (!scheduled)") &&
    fieldPageSrc.includes("scheduled={job.scheduledAt != null}"),
);
check(
  "Unscheduled path is checked before the customer-confirmation warning",
  startButtonSrc.indexOf("if (!scheduled)") <
    startButtonSrc.indexOf("if (!appointmentConfirmed)"),
);
check(
  "Start Job form is only after scheduled + appointmentConfirmed",
  startButtonSrc.indexOf("if (!appointmentConfirmed)") <
    startButtonSrc.indexOf("{pending ? \"Starting…\" : \"Start Job\"}"),
);
check(
  "Scheduled unconfirmed jobs keep the existing confirmation reason",
  startButtonSrc.includes(CUSTOMER_NOT_CONFIRMED) &&
    fieldPageSrc.includes("appointmentConfirmed={isCurrentAppointmentConfirmed(job)}"),
);
check(
  "No Field confirmation override and no MEMBER property-access bypass",
  !startButtonSrc.includes("startWithoutConfirmation") &&
    !startButtonSrc.includes("overrideReason") &&
    !startButtonSrc.includes("START_WITHOUT_CONFIRMATION") &&
    !fieldPageSrc.includes("startWithoutConfirmation") &&
    !fieldPageSrc.includes("overrideReason") &&
    fieldPageSrc.includes("isCurrentAppointmentConfirmed(job)"),
);

console.log("\nSTATIC — Security, contact, and #147 completion stay intact");
check(
  "requireAssignedJobPageAccess + assignedJobWhere remain the page boundary",
  fieldPageSrc.includes("await requireAssignedJobPageAccess(jobId)") &&
    fieldPageSrc.includes("where: assignedJobWhere(jobId, field)") &&
    fieldAccessSrc.includes("assignedMembershipId: field.membershipId") &&
    !fieldAccessSrc.includes('role === "OWNER"') &&
    !fieldAccessSrc.includes('role === "ADMIN"'),
);
check(
  "Field page still offers Call Customer, Directions, and access instructions",
  fieldPageSrc.includes("Call Customer") &&
    fieldPageSrc.includes("Directions") &&
    fieldPageSrc.includes("ownerAccessSummaryLines(job)") &&
    fieldPageSrc.includes("telHref") &&
    fieldPageSrc.includes("directionsUrl"),
);
check(
  "IN_PROGRESS still renders Complete Job; COMPLETED still shows the completed message",
  fieldPageSrc.includes("{isInProgress ? <CompleteAssignedJobButton jobId={job.id} /> : null}") &&
    fieldPageSrc.includes("This job is complete.") &&
    completeButtonSrc.includes("Complete Job") &&
    completeButtonSrc.includes("completeAssignedJob"),
);
check(
  "#147 completion/time-clock safety is untouched in the Field action",
  fieldActionSrc.includes("completeJobWithRunningTimeSafety") &&
    fieldActionSrc.includes("startJobRequiresCustomerConfirmation") &&
    timeCardOpsSrc.includes("completeJobWithRunningTimeSafety") &&
    timeCardOpsSrc.includes("JOB_COMPLETION_TIME_CLOSED_REASON"),
);
check(
  "Field page still does not select or render financial fields",
  !jobSelectSrc.includes("invoice") &&
    !jobSelectSrc.includes("margin") &&
    fieldPageSrc.includes("hideFinancials"),
);

console.log("\nUNIT — Arrival window copy from the same UTC instant");
const NY = "America/New_York";
const LA = "America/Los_Angeles";
const sharedInstant = new Date("2026-09-26T13:00:00.000Z");
const nyExact = exactAppointmentCopy(sharedInstant, NY);
const laExact = exactAppointmentCopy(sharedInstant, LA);
const nyWindow = arrivalWindowCopy(sharedInstant, 120, NY);
const laWindow = arrivalWindowCopy(sharedInstant, 120, LA);
const zeroWindow = exactAppointmentCopy(sharedInstant, NY);
const nullWindowEndUnused = formatDateTime(sharedInstant, NY);

check(
  "Persisted 13:00Z is 9:00 AM New York and 6:00 AM Los Angeles",
  formatTime(sharedInstant, NY) === "9:00 AM" &&
    formatTime(sharedInstant, LA) === "6:00 AM" &&
    formatDateTime(sharedInstant, NY).includes("9:00 AM") &&
    formatDateTime(sharedInstant, LA).includes("6:00 AM") &&
    resolveBusinessTimeZone({ timezone: NY }) === NY &&
    resolveBusinessTimeZone({ timezone: LA }) === LA,
);
check(
  "120-minute arrival window ends at 11:00 AM NY / 8:00 AM LA from the same instant",
  windowEnd(sharedInstant, 120).toISOString() === "2026-09-26T15:00:00.000Z" &&
    formatTime(windowEnd(sharedInstant, 120), NY) === "11:00 AM" &&
    formatTime(windowEnd(sharedInstant, 120), LA) === "8:00 AM" &&
    nyWindow === `Arrival window: ${formatDateTime(sharedInstant, NY)} – ${formatTime(windowEnd(sharedInstant, 120), NY)}` &&
    laWindow === `Arrival window: ${formatDateTime(sharedInstant, LA)} – ${formatTime(windowEnd(sharedInstant, 120), LA)}` &&
    nyWindow.includes("9:00 AM") &&
    nyWindow.includes("11:00 AM") &&
    laWindow.includes("6:00 AM") &&
    laWindow.includes("8:00 AM"),
);
check(
  "null and 0 arrival windows display the exact appointment time, not a window",
  nyExact === `Appointment time: ${formatDateTime(sharedInstant, NY)}` &&
    laExact === `Appointment time: ${formatDateTime(sharedInstant, LA)}` &&
    zeroWindow === nyExact &&
    nyExact.includes("9:00 AM") &&
    laExact.includes("6:00 AM") &&
    !nullWindowEndUnused.includes("Arrival window"),
);
check(
  "isCurrentAppointmentConfirmed stays false for an unscheduled job",
  isCurrentAppointmentConfirmed({
    scheduledAt: null,
    scheduledDurationMinutes: null,
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
  }) === false,
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const repoRoot = new URL("..", import.meta.url).pathname;
if (!existsSync(`${repoRoot}.next`)) {
  console.error(
    "No .next build output found. Run `npm run build` before this check.",
  );
  process.exit(1);
}

const testDbName = "tbbt_field_appointment_readiness_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for field-appointment-readiness test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

const onboardingDone = new Date();
const completedOnboarding = {
  firstRunSetupCompletedAt: onboardingDone,
  starterServicesSetupCompletedAt: onboardingDone,
  starterServicesSetupChoice: "SKIPPED",
  websiteSetupCompletedAt: onboardingDone,
  websiteSetupChoice: "SKIPPED",
};

let serverProcess;
try {
  const businessNy = await prisma.business.create({
    data: {
      name: "NY Field Readiness",
      slug: `ny-field-ready-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
      ...completedOnboarding,
    },
  });
  const businessLa = await prisma.business.create({
    data: {
      name: "LA Field Readiness",
      slug: `la-field-ready-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: LA,
      ...completedOnboarding,
    },
  });

  const nyMemberUser = await prisma.user.create({
    data: { name: "Nina Field", email: "nina@field-ready.example", passwordHash: "x" },
  });
  const nyOtherUser = await prisma.user.create({
    data: { name: "Omar Other", email: "omar@field-ready.example", passwordHash: "x" },
  });
  const laMemberUser = await prisma.user.create({
    data: { name: "Lena Field", email: "lena@field-ready.example", passwordHash: "x" },
  });

  const nyMembership = await prisma.membership.create({
    data: { userId: nyMemberUser.id, businessId: businessNy.id, role: "MEMBER" },
  });
  const nyOtherMembership = await prisma.membership.create({
    data: { userId: nyOtherUser.id, businessId: businessNy.id, role: "MEMBER" },
  });
  const laMembership = await prisma.membership.create({
    data: { userId: laMemberUser.id, businessId: businessLa.id, role: "MEMBER" },
  });

  const nyCustomer = await prisma.customer.create({
    data: { businessId: businessNy.id, name: "Nora Canary Ready Q9x", phone: "555-0147" },
  });
  const nyProperty = await prisma.property.create({
    data: {
      businessId: businessNy.id,
      customerId: nyCustomer.id,
      addressLine1: "18 Readiness Lane",
      city: "Queens",
      region: "NY",
      postalCode: "11101",
    },
  });
  const laCustomer = await prisma.customer.create({
    data: { businessId: businessLa.id, name: "Lara Canary Ready Q9x", phone: "555-0148" },
  });
  const laProperty = await prisma.property.create({
    data: {
      businessId: businessLa.id,
      customerId: laCustomer.id,
      addressLine1: "90 Sunset Blvd",
      city: "Los Angeles",
      region: "CA",
      postalCode: "90028",
    },
  });

  const confirmed = {
    appointmentProposalId: 1,
    appointmentConfirmationStatus: "CONFIRMED",
    appointmentConfirmedForProposalId: 1,
    appointmentConfirmationSource: "PORTAL",
    propertyAccessMethod: "KEY_AT_PROPERTY",
    propertyAccessInstructions: ACCESS_INSTRUCTIONS,
  };

  const unscheduledJob = await prisma.job.create({
    data: {
      businessId: businessNy.id,
      customerId: nyCustomer.id,
      propertyId: nyProperty.id,
      projectToken: randomUUID(),
      status: "UNSCHEDULED",
      scheduledAt: null,
      assignedMembershipId: nyMembership.id,
    },
  });
  const unconfirmedJob = await prisma.job.create({
    data: {
      businessId: businessNy.id,
      customerId: nyCustomer.id,
      propertyId: nyProperty.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: sharedInstant,
      scheduledDurationMinutes: 60,
      arrivalWindowMinutes: null,
      appointmentProposalId: 1,
      appointmentConfirmationStatus: "AWAITING_CUSTOMER",
      assignedMembershipId: nyMembership.id,
      propertyAccessMethod: "CUSTOMER_PRESENT",
    },
  });
  const exactConfirmedJob = await prisma.job.create({
    data: {
      businessId: businessNy.id,
      customerId: nyCustomer.id,
      propertyId: nyProperty.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: sharedInstant,
      scheduledDurationMinutes: 60,
      arrivalWindowMinutes: 0,
      assignedMembershipId: nyMembership.id,
      ...confirmed,
    },
  });
  const windowConfirmedJob = await prisma.job.create({
    data: {
      businessId: businessNy.id,
      customerId: nyCustomer.id,
      propertyId: nyProperty.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: sharedInstant,
      arrivalWindowMinutes: 120,
      assignedMembershipId: nyMembership.id,
      ...confirmed,
    },
  });
  const inProgressJob = await prisma.job.create({
    data: {
      businessId: businessNy.id,
      customerId: nyCustomer.id,
      propertyId: nyProperty.id,
      projectToken: randomUUID(),
      status: "IN_PROGRESS",
      scheduledAt: sharedInstant,
      assignedMembershipId: nyMembership.id,
      ...confirmed,
    },
  });
  const completedJob = await prisma.job.create({
    data: {
      businessId: businessNy.id,
      customerId: nyCustomer.id,
      propertyId: nyProperty.id,
      projectToken: randomUUID(),
      status: "COMPLETED",
      scheduledAt: sharedInstant,
      assignedMembershipId: nyMembership.id,
      ...confirmed,
    },
  });
  const laWindowJob = await prisma.job.create({
    data: {
      businessId: businessLa.id,
      customerId: laCustomer.id,
      propertyId: laProperty.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: sharedInstant,
      arrivalWindowMinutes: 120,
      assignedMembershipId: laMembership.id,
      appointmentProposalId: 1,
      appointmentConfirmationStatus: "CONFIRMED",
      appointmentConfirmedForProposalId: 1,
      appointmentConfirmationSource: "PORTAL",
      propertyAccessMethod: "CUSTOMER_PRESENT",
    },
  });
  const unassignedJob = await prisma.job.create({
    data: {
      businessId: businessNy.id,
      customerId: nyCustomer.id,
      propertyId: nyProperty.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: sharedInstant,
      assignedMembershipId: null,
    },
  });
  const foreignJob = await prisma.job.create({
    data: {
      businessId: businessLa.id,
      customerId: laCustomer.id,
      propertyId: laProperty.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: sharedInstant,
      assignedMembershipId: laMembership.id,
    },
  });

  console.log("\nDB — Assignment scope still fails closed without a schedule query");
  const fieldNy = { businessId: businessNy.id, membershipId: nyMembership.id };
  const assignedRow = await prisma.job.findFirst({
    where: assignedJobWhere(unscheduledJob.id, fieldNy),
    select: { id: true, arrivalWindowMinutes: true },
  });
  const otherMemberRow = await prisma.job.findFirst({
    where: assignedJobWhere(unscheduledJob.id, {
      businessId: businessNy.id,
      membershipId: nyOtherMembership.id,
    }),
  });
  const foreignRow = await prisma.job.findFirst({
    where: assignedJobWhere(foreignJob.id, fieldNy),
  });
  const unassignedRow = await prisma.job.findFirst({
    where: assignedJobWhere(unassignedJob.id, fieldNy),
  });
  check("Assigned worker can load their unscheduled Job through assignedJobWhere", assignedRow?.id === unscheduledJob.id);
  check("Unassigned same-business member cannot load that Job", otherMemberRow === null);
  check("Foreign-tenant Job fails closed through assignedJobWhere", foreignRow === null);
  check("Unassigned Job fails closed through assignedJobWhere", unassignedRow === null);

  const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  async function makeSession(user, businessId) {
    const token = randomUUID();
    await prisma.session.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt: farFuture },
    });
    return { token, businessId };
  }
  const nySession = await makeSession(nyMemberUser, businessNy.id);
  const nyOtherSession = await makeSession(nyOtherUser, businessNy.id);
  const laSession = await makeSession(laMemberUser, businessLa.id);

  const PORT = 43891;
  const APP_URL = `http://127.0.0.1:${PORT}`;

  async function waitForServer(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${APP_URL}/sign-in`, { redirect: "manual" });
        if (res.status < 500) return true;
      } catch {
        // not up yet
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }

  function cookieHeader(session) {
    return `tbbt_session=${session.token}; tbbt_workspace=${session.businessId}`;
  }

  async function fetchRaw(session, path) {
    const res = await fetch(`${APP_URL}${path}`, {
      redirect: "manual",
      headers: session ? { cookie: cookieHeader(session) } : {},
    });
    const body = await res.text().catch(() => "");
    return { status: res.status, location: res.headers.get("location"), body };
  }

  console.log(`\nStarting built app on ${APP_URL} against the test database...`);
  serverProcess = spawn(
    "node_modules/.bin/next",
    ["start", "--hostname", "127.0.0.1", "--port", String(PORT)],
    {
      cwd: repoRoot.replace(/\/$/, ""),
      env: { ...process.env, DATABASE_URL: testUrl, NODE_ENV: "production" },
      stdio: "pipe",
    },
  );
  let serverOutput = "";
  serverProcess.stdout.on("data", (chunk) => (serverOutput += chunk.toString()));
  serverProcess.stderr.on("data", (chunk) => (serverOutput += chunk.toString()));

  const up = await waitForServer(30_000);
  if (!up) {
    console.error("Server did not start in time. Output so far:\n" + serverOutput);
    process.exit(1);
  }

  console.log("\nHTTP — Readiness states on the assigned Field Job page");
  const unscheduledPage = await fetchRaw(nySession, `/field/jobs/${unscheduledJob.id}`);
  check("Assigned unscheduled Job returns 200", unscheduledPage.status === 200);
  check(
    "Unscheduled assigned job says waiting for office scheduling",
    unscheduledPage.body.includes(WAITING_FOR_OFFICE),
  );
  check(
    "Unscheduled job does NOT say customer has not confirmed",
    !unscheduledPage.body.includes(CUSTOMER_NOT_CONFIRMED),
  );
  check("Unscheduled job has no Start Job action", !hasStartJobSubmit(unscheduledPage.body));
  check(
    "Unscheduled job still shows Call Customer and Directions",
    unscheduledPage.body.includes("Call Customer") &&
      unscheduledPage.body.includes("Directions") &&
      unscheduledPage.body.includes("tel:555-0147"),
  );

  const unconfirmedPage = await fetchRaw(nySession, `/field/jobs/${unconfirmedJob.id}`);
  check("Scheduled unconfirmed Job returns 200", unconfirmedPage.status === 200);
  check(
    "Scheduled unconfirmed job shows confirmation warning and no Start",
    unconfirmedPage.body.includes(CUSTOMER_NOT_CONFIRMED) &&
      !unconfirmedPage.body.includes(WAITING_FOR_OFFICE) &&
      !hasStartJobSubmit(unconfirmedPage.body),
  );
  check(
    "Scheduled unconfirmed exact-time job still labels the appointment time",
    unconfirmedPage.body.includes(nyExact),
  );

  const exactPage = await fetchRaw(nySession, `/field/jobs/${exactConfirmedJob.id}`);
  check("Confirmed exact-time Job returns 200", exactPage.status === 200);
  check("Confirmed scheduled job shows Start", hasStartJobSubmit(exactPage.body));
  check(
    "null/0 arrival window displays exact appointment time in Business timezone",
    exactPage.body.includes(nyExact) && !exactPage.body.includes("Arrival window:"),
  );
  check(
    "Confirmed exact-time job does not show unscheduled or unconfirmed copy",
    !exactPage.body.includes(WAITING_FOR_OFFICE) &&
      !exactPage.body.includes(CUSTOMER_NOT_CONFIRMED),
  );
  check(
    "Existing access instructions remain on a scheduled confirmed job",
    exactPage.body.includes(ACCESS_INSTRUCTIONS) &&
      exactPage.body.includes("Call Customer") &&
      exactPage.body.includes("Directions"),
  );

  const windowNyPage = await fetchRaw(nySession, `/field/jobs/${windowConfirmedJob.id}`);
  check("Confirmed arrival-window Job returns 200", windowNyPage.status === 200);
  check(
    "arrivalWindowMinutes > 0 displays correct NY start/end",
    windowNyPage.body.includes("Arrival window:") &&
      windowNyPage.body.includes(formatDateTime(sharedInstant, NY)) &&
      windowNyPage.body.includes(formatTime(windowEnd(sharedInstant, 120), NY)) &&
      !windowNyPage.body.includes(nyExact),
  );
  check("Arrival-window confirmed job still shows Start", hasStartJobSubmit(windowNyPage.body));

  const windowLaPage = await fetchRaw(laSession, `/field/jobs/${laWindowJob.id}`);
  check("Los Angeles assigned window Job returns 200", windowLaPage.status === 200);
  check(
    "Same UTC instant renders the LA arrival window, not the NY clock",
    windowLaPage.body.includes("Arrival window:") &&
      windowLaPage.body.includes(formatDateTime(sharedInstant, LA)) &&
      windowLaPage.body.includes(formatTime(windowEnd(sharedInstant, 120), LA)) &&
      !windowLaPage.body.includes(formatTime(sharedInstant, NY)) &&
      !windowNyPage.body.includes(formatTime(sharedInstant, LA)),
  );

  const inProgressPage = await fetchRaw(nySession, `/field/jobs/${inProgressJob.id}`);
  check(
    "IN_PROGRESS preserves Complete Job and does not offer Start",
    inProgressPage.status === 200 &&
      hasCompleteJobSubmit(inProgressPage.body) &&
      !hasStartJobSubmit(inProgressPage.body) &&
      !inProgressPage.body.includes(WAITING_FOR_OFFICE),
  );
  const completedPage = await fetchRaw(nySession, `/field/jobs/${completedJob.id}`);
  check(
    "COMPLETED preserves the completed message and does not offer Start",
    completedPage.status === 200 &&
      completedPage.body.includes("This job is complete.") &&
      !hasStartJobSubmit(completedPage.body) &&
      !hasCompleteJobSubmit(completedPage.body),
  );

  console.log("\nHTTP — Foreign / unassigned Field Job still fails closed");
  const otherMemberPage = await fetchRaw(nyOtherSession, `/field/jobs/${exactConfirmedJob.id}`);
  const foreignPage = await fetchRaw(nySession, `/field/jobs/${foreignJob.id}`);
  const unassignedPage = await fetchRaw(nySession, `/field/jobs/${unassignedJob.id}`);
  const laOnNy = await fetchRaw(laSession, `/field/jobs/${exactConfirmedJob.id}`);
  check(
    "Same-business unassigned member gets 404 with no customer leak",
    otherMemberPage.status === 404 && !otherMemberPage.body.includes(nyCustomer.name),
  );
  check(
    "Foreign-tenant Job is 404 with no customer leak",
    foreignPage.status === 404 && !foreignPage.body.includes(laCustomer.name),
  );
  check(
    "Unassigned Job is 404 with no customer leak",
    unassignedPage.status === 404 && !unassignedPage.body.includes(nyCustomer.name),
  );
  check(
    "LA member cannot open the NY Field Job",
    laOnNy.status === 404 && !laOnNy.body.includes(nyCustomer.name),
  );
} finally {
  if (serverProcess) {
    serverProcess.kill("SIGKILL");
  }
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

console.log(
  failures === 0
    ? "\nAll field appointment-readiness checks passed."
    : `\n${failures} field appointment-readiness check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);

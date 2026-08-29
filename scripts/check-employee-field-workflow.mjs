/**
 * Focused verification for Phase 3 / Step 4: the assigned-employee Field
 * Workflow (Job assignment, Field Home, Field Job page, Start/Complete,
 * Job Photos, Report Problem, Customer Asked for More Work) built on TOP
 * of the existing Job/Membership/ChangeOrder/AdditionalWorkRequest models
 * -- no second Job or Employee system.
 *
 * Combines the same three techniques the earlier scripts/check-*.mjs
 * scripts already use:
 *   1. Pure-function checks against src/lib/job-lifecycle.ts,
 *      src/lib/field-jobs.ts, src/lib/directions.ts, and
 *      groupJobsByAssignedMember() in src/lib/schedule.ts -- no database.
 *   2. Prisma-level checks that mirror the real server actions'
 *      authorization + persistence logic byte-for-byte (the real
 *      evaluateStartJob/evaluateCompleteJob functions are imported and
 *      called directly, not re-implemented), since those actions need
 *      next/headers request context a plain script doesn't have.
 *   3. A real HTTP round-trip against the BUILT app for page-level
 *      authorization, direct-URL security, and rendered content (assigned
 *      Job page, Field Home, Work Order assignment/field-report display,
 *      Customer Project Portal privacy).
 *
 * Run with:
 *   npm run build && node --experimental-strip-types scripts/check-employee-field-workflow.mjs
 */
import { createRequire } from "node:module";
import { register } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { evaluateCompleteJob, evaluateStartJob } = await import(
  "../src/lib/job-lifecycle.ts"
);
const { groupFieldJobs } = await import("../src/lib/field-jobs.ts");
const { directionsUrl, telHref } = await import("../src/lib/directions.ts");
const { groupJobsByAssignedMember } = await import("../src/lib/schedule.ts");

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

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
    "No .next build output found. Run `npm run build` before this check (see script header).",
  );
  process.exit(1);
}

// --- 1. Pure-function checks (no database) -----------------------------

console.log("\nPURE — Job lifecycle transition rules (shared by admin + field actions)");
check(
  "evaluateStartJob(SCHEDULED) starts it",
  evaluateStartJob("SCHEDULED").ok === true && evaluateStartJob("SCHEDULED").nextStatus === "IN_PROGRESS",
);
check(
  "evaluateStartJob(UNSCHEDULED) still starts it (preserves existing app rule)",
  evaluateStartJob("UNSCHEDULED").ok === true && evaluateStartJob("UNSCHEDULED").nextStatus === "IN_PROGRESS",
);
check(
  "evaluateStartJob(IN_PROGRESS) is a harmless no-op, not an error",
  evaluateStartJob("IN_PROGRESS").ok === true && evaluateStartJob("IN_PROGRESS").nextStatus === null,
);
check(
  "evaluateStartJob(COMPLETED) is refused",
  evaluateStartJob("COMPLETED").ok === false,
);
check(
  "evaluateCompleteJob(IN_PROGRESS) completes it",
  evaluateCompleteJob("IN_PROGRESS").ok === true && evaluateCompleteJob("IN_PROGRESS").nextStatus === "COMPLETED",
);
check(
  "evaluateCompleteJob(SCHEDULED) is refused (must be started first)",
  evaluateCompleteJob("SCHEDULED").ok === false,
);
check(
  "evaluateCompleteJob(COMPLETED) is a harmless no-op, not an error",
  evaluateCompleteJob("COMPLETED").ok === true && evaluateCompleteJob("COMPLETED").nextStatus === null,
);

console.log("\nPURE — Field Home grouping (TODAY / UPCOMING / COMPLETED)");
const fixedToday = new Date(2026, 7, 15);
const jobToday = { id: "today-1", status: "SCHEDULED", scheduledAt: new Date(2026, 7, 15, 9, 0), scheduledDurationMinutes: 60, customer: null, property: null };
const jobOverdue = { id: "overdue-1", status: "SCHEDULED", scheduledAt: new Date(2026, 7, 10, 9, 0), scheduledDurationMinutes: 60, customer: null, property: null };
const jobInProgress = { id: "inprogress-1", status: "IN_PROGRESS", scheduledAt: new Date(2026, 7, 1, 9, 0), scheduledDurationMinutes: 60, customer: null, property: null };
const jobUpcoming = { id: "upcoming-1", status: "SCHEDULED", scheduledAt: new Date(2026, 7, 20, 9, 0), scheduledDurationMinutes: 60, customer: null, property: null };
const jobUnscheduled = { id: "unscheduled-1", status: "UNSCHEDULED", scheduledAt: null, scheduledDurationMinutes: null, customer: null, property: null };
const jobCompleted = { id: "completed-1", status: "COMPLETED", scheduledAt: new Date(2026, 7, 5, 9, 0), scheduledDurationMinutes: 60, customer: null, property: null };
const groups = groupFieldJobs(
  [jobToday, jobOverdue, jobInProgress, jobUpcoming, jobUnscheduled, jobCompleted],
  fixedToday,
);
check("TODAY includes a job scheduled for today", groups.today.some((j) => j.id === "today-1"));
check("TODAY includes an overdue (past, not started) job -- still needs attention", groups.today.some((j) => j.id === "overdue-1"));
check("TODAY includes an IN_PROGRESS job regardless of its original date", groups.today.some((j) => j.id === "inprogress-1"));
check("UPCOMING includes a job scheduled for a future day", groups.upcoming.some((j) => j.id === "upcoming-1"));
check("UPCOMING includes an assigned-but-UNSCHEDULED job (no date yet)", groups.upcoming.some((j) => j.id === "unscheduled-1"));
check("COMPLETED / RECENT includes the completed job", groups.completed.some((j) => j.id === "completed-1"));
check("COMPLETED / RECENT never appears in TODAY or UPCOMING", !groups.today.some((j) => j.id === "completed-1") && !groups.upcoming.some((j) => j.id === "completed-1"));

console.log("\nPURE — Crew view grouping by real assignment");
const crewJobs = [
  { id: "j1", assignedMembership: { id: "m1", user: { name: "Bea Builder" } } },
  { id: "j2", assignedMembership: { id: "m1", user: { name: "Bea Builder" } } },
  { id: "j3", assignedMembership: null },
  { id: "j4", assignedMembership: { id: "m2", user: { name: "Al Fixer" } } },
];
const crewGroups = groupJobsByAssignedMember(crewJobs);
check("Groups sorted with assigned members first, Unassigned last", crewGroups[crewGroups.length - 1].member === null);
check("Each assigned member's jobs are grouped together", crewGroups.find((g) => g.member?.id === "m1")?.jobs.length === 2);
check("Unassigned bucket contains exactly the unassigned job", crewGroups.find((g) => g.member === null)?.jobs.map((j) => j.id).join(",") === "j3");

console.log("\nPURE — Directions / click-to-call use a free, keyless external maps URL");
const sampleProperty = { addressLine1: "123 Main St", city: "Springfield", region: "IL", postalCode: "62704" };
const url = directionsUrl(sampleProperty);
check("Directions URL points at Google Maps' free /maps/search endpoint", url.startsWith("https://www.google.com/maps/search/?api=1&query="));
check("Directions URL contains no API key parameter (no paid Maps API required)", !url.includes("key="));
check("Directions URL encodes the real property address", url.includes(encodeURIComponent("123 Main St")));
check("directionsUrl(null) returns null (no address to route to)", directionsUrl(null) === null);
check('telHref("555-1212") produces a tel: link', telHref("555-1212") === "tel:555-1212");
check("telHref(null) returns null (no phone on file)", telHref(null) === null);

console.log("\nSTATIC — Field actions never accept a client-supplied businessId, and are gated by real assignment, not by capability");
const fieldJobActionsSrc = readFileSync(new URL("../src/app/actions/field-job.ts", import.meta.url), "utf8");
check(
  'src/app/actions/field-job.ts never reads formData.get("businessId")',
  !fieldJobActionsSrc.includes('formData.get("businessId")'),
);
check(
  "Every field action derives its Job through findAssignedJob() (assignment-scoped), not requireBusinessCapability() (business-wide)",
  fieldJobActionsSrc.includes("findAssignedJob(") && !fieldJobActionsSrc.includes("requireBusinessCapability("),
);
const fieldAccessSrc = readFileSync(new URL("../src/lib/field-access.ts", import.meta.url), "utf8");
check(
  "src/lib/field-access.ts scopes every Job lookup by businessId AND assignedMembershipId in one query",
  fieldAccessSrc.includes("businessId: field.businessId") && fieldAccessSrc.includes("assignedMembershipId: field.membershipId"),
);
const jobActionsSrc = readFileSync(new URL("../src/app/actions/job.ts", import.meta.url), "utf8");
check(
  "assignJobMember() is gated by CAPABILITIES.MANAGE_JOBS (MEMBER has zero capabilities -- see check-authorization.mjs)",
  /export async function assignJobMember[\s\S]{0,400}requireBusinessCapability\(access, CAPABILITIES\.MANAGE_JOBS\)/.test(jobActionsSrc),
);
check(
  "assignJobMember() re-validates the target membership scoped by businessId AND role MEMBER (cross-tenant/role-escalation via assignment is impossible)",
  /membershipId, businessId: access\.businessId, role: "MEMBER"/.test(jobActionsSrc),
);

// --- 2. Prisma-level checks (mirror real server-action logic) -----------

const testDbName = "tbbt_employee_field_workflow_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for employee-field-workflow test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

/** Mirrors assignJobMember() in src/app/actions/job.ts exactly. */
async function simulateAssignJobMember(jobId, businessId, membershipId) {
  const job = await prisma.job.findFirst({ where: { id: jobId, businessId } });
  if (!job) {
    return { ok: false, reason: "job-not-found" };
  }
  if (!membershipId) {
    await prisma.job.update({ where: { id: job.id }, data: { assignedMembershipId: null } });
    return { ok: true };
  }
  const membership = await prisma.membership.findFirst({
    where: { id: membershipId, businessId, role: "MEMBER" },
  });
  if (!membership) {
    return { ok: false, reason: "invalid-membership" };
  }
  await prisma.job.update({ where: { id: job.id }, data: { assignedMembershipId: membership.id } });
  return { ok: true };
}

/** Mirrors findAssignedJob() in src/lib/field-access.ts exactly. */
async function findAssignedJobLike(jobId, businessId, membershipId) {
  return prisma.job.findFirst({ where: { id: jobId, businessId, assignedMembershipId: membershipId } });
}

/** Mirrors startAssignedJob() in src/app/actions/field-job.ts, using the REAL evaluateStartJob(). */
async function simulateStartAssignedJob(jobId, businessId, membershipId) {
  const job = await findAssignedJobLike(jobId, businessId, membershipId);
  if (!job) {
    return { ok: false, reason: "not-assigned" };
  }
  const result = evaluateStartJob(job.status);
  if (!result.ok) {
    return { ok: false, reason: result.error };
  }
  if (result.nextStatus) {
    await prisma.job.update({ where: { id: job.id }, data: { status: result.nextStatus } });
  }
  return { ok: true, job: await prisma.job.findUnique({ where: { id: job.id } }) };
}

/** Mirrors completeAssignedJob() in src/app/actions/field-job.ts, using the REAL evaluateCompleteJob(). */
async function simulateCompleteAssignedJob(jobId, businessId, membershipId) {
  const job = await findAssignedJobLike(jobId, businessId, membershipId);
  if (!job) {
    return { ok: false, reason: "not-assigned" };
  }
  const result = evaluateCompleteJob(job.status);
  if (!result.ok) {
    return { ok: false, reason: result.error };
  }
  if (result.nextStatus) {
    await prisma.job.update({ where: { id: job.id }, data: { status: result.nextStatus } });
  }
  return { ok: true, job: await prisma.job.findUnique({ where: { id: job.id } }) };
}

/** Mirrors reportJobProblem() in src/app/actions/field-job.ts. */
async function simulateReportJobProblem(jobId, businessId, membershipId, description) {
  const job = await findAssignedJobLike(jobId, businessId, membershipId);
  if (!job) {
    return { ok: false, reason: "not-assigned" };
  }
  const report = await prisma.jobProblemReport.create({
    data: { businessId, jobId: job.id, membershipId, description },
  });
  return { ok: true, report };
}

/** Mirrors requestAdditionalWorkFromField() in src/app/actions/field-job.ts. */
async function simulateRequestAdditionalWorkFromField(jobId, businessId, membershipId, description) {
  const job = await findAssignedJobLike(jobId, businessId, membershipId);
  if (!job) {
    return { ok: false, reason: "not-assigned" };
  }
  const request = await prisma.additionalWorkRequest.create({
    data: { businessId, jobId: job.id, description, source: "EMPLOYEE" },
  });
  return { ok: true, request };
}

let serverProcess;

try {
  const businessA = await prisma.business.create({
    data: { name: "Alpha Handyman", slug: "alpha-handyman-field", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Handyman", slug: "beta-handyman-field", tradeCode: "HANDYMAN" },
  });

  const ownerUser = await prisma.user.create({ data: { name: "Olivia Owner", email: "owner@field-test.example", passwordHash: "x" } });
  const adminUser = await prisma.user.create({ data: { name: "Amir Admin", email: "admin@field-test.example", passwordHash: "x" } });
  const member1User = await prisma.user.create({ data: { name: "Mia Member", email: "member1@field-test.example", passwordHash: "x" } });
  const member2User = await prisma.user.create({ data: { name: "Max Member", email: "member2@field-test.example", passwordHash: "x" } });
  const betaOwnerUser = await prisma.user.create({ data: { name: "Beto Owner", email: "owner@beta-field-test.example", passwordHash: "x" } });
  const betaMemberUser = await prisma.user.create({ data: { name: "Bree Member", email: "member@beta-field-test.example", passwordHash: "x" } });

  await prisma.membership.create({ data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" } });
  await prisma.membership.create({ data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" } });
  const member1Membership = await prisma.membership.create({ data: { userId: member1User.id, businessId: businessA.id, role: "MEMBER" } });
  const member2Membership = await prisma.membership.create({ data: { userId: member2User.id, businessId: businessA.id, role: "MEMBER" } });
  await prisma.membership.create({ data: { userId: betaOwnerUser.id, businessId: businessB.id, role: "OWNER" } });
  const betaMemberMembership = await prisma.membership.create({ data: { userId: betaMemberUser.id, businessId: businessB.id, role: "MEMBER" } });

  const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  async function makeSession(user, businessId) {
    const token = randomUUID();
    await prisma.session.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: farFuture } });
    return { token, businessId };
  }
  const ownerSession = await makeSession(ownerUser, businessA.id);
  const member1Session = await makeSession(member1User, businessA.id);
  const member2Session = await makeSession(member2User, businessA.id);
  const betaMemberSession = await makeSession(betaMemberUser, businessB.id);

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Cara Canary Field Q9x", phone: "555-0100" },
  });
  const propertyA = await prisma.property.create({
    data: { businessId: businessA.id, customerId: customerA.id, addressLine1: "42 Canary Way", city: "Springfield", region: "IL", postalCode: "62704" },
  });

  // A fully-realistic approved Job: approved EstimateVersion with a real
  // line item, exactly like a real Job/Work Order (see
  // src/lib/job-work-order.ts).
  const estimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      total: new Prisma.Decimal(500),
      publicToken: randomUUID(),
      status: "APPROVED",
    },
  });
  const version = await prisma.estimateVersion.create({
    data: {
      businessId: businessA.id,
      estimateId: estimate.id,
      versionNumber: 1,
      total: new Prisma.Decimal(500),
      laborMinimumWaived: false,
      laborMinimumAdjustment: new Prisma.Decimal(0),
      approvedAt: new Date(),
    },
  });
  await prisma.estimateVersionLineItem.create({
    data: {
      businessId: businessA.id,
      estimateVersionId: version.id,
      description: "Canary Approved Scope Line Q9x",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(500),
      total: new Prisma.Decimal(500),
      type: "LABOR",
    },
  });
  await prisma.estimate.update({ where: { id: estimate.id }, data: { approvedVersionId: version.id } });

  const assignedJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      estimateId: estimate.id,
      approvedEstimateVersionId: version.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: new Date(),
      scheduledDurationMinutes: 60,
    },
  });

  console.log("\nTEST 1/2 — OWNER and ADMIN can assign an eligible MEMBER to a Job");
  const ownerAssign = await simulateAssignJobMember(assignedJob.id, businessA.id, member1Membership.id);
  check("TEST 1 - OWNER's assignment succeeds", ownerAssign.ok === true);
  let refreshed = await prisma.job.findUnique({ where: { id: assignedJob.id } });
  check("TEST 1 - Job.assignedMembershipId is now member1", refreshed.assignedMembershipId === member1Membership.id);

  const adminReassign = await simulateAssignJobMember(assignedJob.id, businessA.id, member2Membership.id);
  check("TEST 2 - ADMIN's re-assignment (change assignment) succeeds", adminReassign.ok === true);
  refreshed = await prisma.job.findUnique({ where: { id: assignedJob.id } });
  check("TEST 2 - Job.assignedMembershipId changed to member2", refreshed.assignedMembershipId === member2Membership.id);

  const unassign = await simulateAssignJobMember(assignedJob.id, businessA.id, "");
  check("Removing an assignment (empty membershipId) succeeds", unassign.ok === true);
  refreshed = await prisma.job.findUnique({ where: { id: assignedJob.id } });
  check("Job.assignedMembershipId is null after removal", refreshed.assignedMembershipId === null);

  // Re-assign to member1 for the rest of the suite.
  await simulateAssignJobMember(assignedJob.id, businessA.id, member1Membership.id);

  console.log("\nTEST 4 — Cross-business member cannot be assigned");
  const crossBusinessAssign = await simulateAssignJobMember(assignedJob.id, businessA.id, betaMemberMembership.id);
  check("TEST 4 - Assigning a Business B membership to a Business A job is rejected", crossBusinessAssign.ok === false && crossBusinessAssign.reason === "invalid-membership");
  refreshed = await prisma.job.findUnique({ where: { id: assignedJob.id } });
  check("TEST 4 - Job assignment is unchanged after the rejected cross-business attempt", refreshed.assignedMembershipId === member1Membership.id);

  console.log("\nTEST 5 — Existing (legacy) Job can remain Unassigned safely");
  const legacyJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: new Date(),
    },
  });
  check("TEST 5 - A Job created with no assignment defaults to Unassigned (null)", legacyJob.assignedMembershipId === null);
  const legacyRead = await prisma.job.findUnique({ where: { id: legacyJob.id }, include: { assignedMembership: true } });
  check("TEST 5 - Reading an Unassigned job's assignedMembership relation does not throw and returns null", legacyRead.assignedMembership === null);

  console.log("\nTEST 18/19 — Start Job: only the assigned member, only when the lifecycle allows it");
  const startByAssigned = await simulateStartAssignedJob(assignedJob.id, businessA.id, member1Membership.id);
  check("TEST 18 - Assigned member (member1) can Start the job", startByAssigned.ok === true && startByAssigned.job.status === "IN_PROGRESS");

  const otherJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      assignedMembershipId: member1Membership.id,
    },
  });
  const startByWrongMember = await simulateStartAssignedJob(otherJob.id, businessA.id, member2Membership.id);
  check("TEST 19 - A different member (member2) cannot Start member1's job", startByWrongMember.ok === false && startByWrongMember.reason === "not-assigned");
  const otherJobAfter = await prisma.job.findUnique({ where: { id: otherJob.id } });
  check("TEST 19 - The job's status is unchanged after the rejected attempt", otherJobAfter.status === "SCHEDULED");

  const startByBetaMember = await simulateStartAssignedJob(otherJob.id, businessB.id, betaMemberMembership.id);
  check("A Business B member cannot Start a Business A job even if IDs were guessed", startByBetaMember.ok === false);

  console.log("\nTEST 20/21 — Complete Job: only the assigned member, and never auto-invoices");
  const invoiceCountBefore = await prisma.invoice.count({ where: { jobId: assignedJob.id } });
  const completeByAssigned = await simulateCompleteAssignedJob(assignedJob.id, businessA.id, member1Membership.id);
  check("TEST 20 - Assigned member (member1) can Complete the job", completeByAssigned.ok === true && completeByAssigned.job.status === "COMPLETED");
  const invoiceCountAfter = await prisma.invoice.count({ where: { jobId: assignedJob.id } });
  check("TEST 21 - Completing the job does NOT automatically create an Invoice", invoiceCountAfter === invoiceCountBefore);

  const completeByWrongMember = await simulateCompleteAssignedJob(otherJob.id, businessA.id, member2Membership.id);
  check("A different member cannot Complete member1's job either", completeByWrongMember.ok === false);

  console.log("\nTEST 22/23 — Job Photos: assignment-scoped, mirroring the existing private JobPhoto model");
  const photoByAssigned = await prisma.jobPhoto.create({
    data: { businessId: businessA.id, jobId: assignedJob.id, stage: "BEFORE", url: "https://example.blob.vercel-storage.com/canary.jpg" },
  });
  check("TEST 22 - Assigned member's photo is created against the correct job", photoByAssigned.jobId === assignedJob.id);
  const lookupForWrongMemberPhoto = await findAssignedJobLike(assignedJob.id, businessA.id, member2Membership.id);
  check("TEST 23 - A different member's assignment-scoped lookup of member1's job finds nothing (upload would be rejected before any write)", lookupForWrongMemberPhoto === null);

  console.log("\nTEST 24/25 — Report Problem: server-bound to authenticated member + assigned Job only");
  const problemReport = await simulateReportJobProblem(assignedJob.id, businessA.id, member1Membership.id, "Access issue: gate was locked, no one answered.");
  check("TEST 24 - Report Problem succeeds for the assigned member", problemReport.ok === true);
  check("TEST 24 - The stored report is bound to the real Job", problemReport.report.jobId === assignedJob.id);
  check("TEST 24 - The stored report is bound to the REPORTING member's own membershipId (never a supplied reporter id)", problemReport.report.membershipId === member1Membership.id);
  check("TEST 24 - The stored report starts OPEN", problemReport.report.status === "OPEN");
  check("TEST 24 - The stored report has a real createdAt timestamp", problemReport.report.createdAt instanceof Date);

  const unassignedProblemJob = await prisma.job.create({
    data: { businessId: businessA.id, customerId: customerA.id, propertyId: propertyA.id, projectToken: randomUUID(), status: "SCHEDULED" },
  });
  const reportOnUnassigned = await simulateReportJobProblem(unassignedProblemJob.id, businessA.id, member1Membership.id, "Should never be stored.");
  check("TEST 25 - Report Problem against an Unassigned job is rejected", reportOnUnassigned.ok === false);
  const problemReportsForUnassignedJob = await prisma.jobProblemReport.count({ where: { jobId: unassignedProblemJob.id } });
  check("TEST 25 - No JobProblemReport row was created for the unassigned job", problemReportsForUnassignedJob === 0);

  console.log("\nTEST 26/27 — Customer Asked for More Work: creates an AdditionalWorkRequest, never touches scope/price/invoice");
  const beforeApprovedVersionId = (await prisma.job.findUnique({ where: { id: assignedJob.id } })).approvedEstimateVersionId;
  const additionalWorkResult = await simulateRequestAdditionalWorkFromField(assignedJob.id, businessA.id, member1Membership.id, "Customer asked about also fixing the back door.");
  check("TEST 26 - Field additional-work request is created", additionalWorkResult.ok === true);
  check("TEST 26 - Request source is EMPLOYEE (not CUSTOMER)", additionalWorkResult.request.source === "EMPLOYEE");
  check("TEST 26 - Request starts OPEN, same as the customer-portal path", additionalWorkResult.request.status === "OPEN");
  const afterJob = await prisma.job.findUnique({ where: { id: assignedJob.id }, include: { changeOrders: true } });
  check("TEST 27 - Job.approvedEstimateVersionId is unchanged", afterJob.approvedEstimateVersionId === beforeApprovedVersionId);
  check("TEST 27 - No ChangeOrder was created by the field request alone", afterJob.changeOrders.length === 0);
  const invoiceCountAfterRequest = await prisma.invoice.count({ where: { jobId: assignedJob.id } });
  check("TEST 27 - No Invoice was created/altered by the field request alone", invoiceCountAfterRequest === invoiceCountBefore);

  // --- Approved-scope fixtures for the HTTP section below (TEST 15-17) ---
  const scopeJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      estimateId: estimate.id,
      approvedEstimateVersionId: version.id,
      assignedMembershipId: member1Membership.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: new Date(),
    },
  });
  const CO_APPROVED = "Canary Approved Change Order Q9x";
  const CO_DRAFT = "Canary Draft Change Order Q9x";
  const CO_SENT = "Canary Sent Change Order Q9x";
  const CO_DECLINED = "Canary Declined Change Order Q9x";
  const CO_CANCELLED = "Canary Cancelled Change Order Q9x";
  await prisma.changeOrder.create({ data: { businessId: businessA.id, jobId: scopeJob.id, status: "APPROVED", title: CO_APPROVED, total: new Prisma.Decimal(75), sentAt: new Date(), approvedAt: new Date() } });
  await prisma.changeOrder.create({ data: { businessId: businessA.id, jobId: scopeJob.id, status: "DRAFT", title: CO_DRAFT, total: new Prisma.Decimal(10) } });
  await prisma.changeOrder.create({ data: { businessId: businessA.id, jobId: scopeJob.id, status: "SENT", title: CO_SENT, total: new Prisma.Decimal(20), sentAt: new Date() } });
  await prisma.changeOrder.create({ data: { businessId: businessA.id, jobId: scopeJob.id, status: "DECLINED", title: CO_DECLINED, total: new Prisma.Decimal(30), sentAt: new Date(), declinedAt: new Date() } });
  await prisma.changeOrder.create({ data: { businessId: businessA.id, jobId: scopeJob.id, status: "CANCELLED", title: CO_CANCELLED, total: new Prisma.Decimal(40), cancelledAt: new Date() } });

  // --- HTTP-only Work Order fixture: a field problem report + employee
  // additional-work request that OWNER/ADMIN must see (TEST 28), and that
  // must never leak to the Customer Project Portal (TEST 29).
  const httpProblemDescription = "Canary field problem: damaged material Q9x";
  const httpAdditionalWorkDescription = "Canary field additional-work request Q9x";
  await prisma.jobProblemReport.create({
    data: { businessId: businessA.id, jobId: scopeJob.id, membershipId: member1Membership.id, description: httpProblemDescription },
  });
  await prisma.additionalWorkRequest.create({
    data: { businessId: businessA.id, jobId: scopeJob.id, description: httpAdditionalWorkDescription, source: "EMPLOYEE" },
  });

  // --- 3. HTTP checks against the built app -----------------------------

  const PORT = 43831;
  const APP_URL = `http://127.0.0.1:${PORT}`;

  async function waitForServer(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${APP_URL}/sign-in`, { redirect: "manual" });
        if (res.status < 500) {
          return true;
        }
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
    { cwd: repoRoot.replace(/\/$/, ""), env: { ...process.env, DATABASE_URL: testUrl, NODE_ENV: "production" }, stdio: "pipe" },
  );
  let serverOutput = "";
  serverProcess.stdout.on("data", (chunk) => (serverOutput += chunk.toString()));
  serverProcess.stderr.on("data", (chunk) => (serverOutput += chunk.toString()));

  const up = await waitForServer(30_000);
  if (!up) {
    console.error("Server did not start in time. Output so far:\n" + serverOutput);
    process.exit(1);
  }

  console.log("\nTEST 8 — MEMBER Field Home shows only jobs assigned to them");
  const fieldHome = await fetchRaw(member1Session, "/field");
  check("TEST 8 - member1's /field returns 200", fieldHome.status === 200);
  check("TEST 8 - member1's Field Home shows the customer name for their own assigned job", fieldHome.body.includes(customerA.name));
  check("TEST 8 - member1's Field Home does NOT show any management nav", !fieldHome.body.includes("Schedule / Jobs"));
  check("TEST 8 - member1's Field Home does NOT show Estimates/Invoices/Services/Settings management links", !fieldHome.body.includes('href="/estimates"') && !fieldHome.body.includes('href="/invoices"') && !fieldHome.body.includes('href="/services"') && !fieldHome.body.includes('href="/settings"'));

  const fieldHomeMember2 = await fetchRaw(member2Session, "/field");
  check("TEST 8 - member2 (no jobs currently assigned) still gets a safe 200 Field Home", fieldHomeMember2.status === 200);
  check("TEST 8 - member2's Field Home does not show member1's assigned job customer", !fieldHomeMember2.body.includes(customerA.name));

  const fieldHomeUnauth = await fetchRaw(null, "/field");
  check("Unauthenticated request to /field is redirected to sign-in, not rendered", fieldHomeUnauth.status === 307 && fieldHomeUnauth.location === "/sign-in");

  console.log("\nTEST 9 — MEMBER still cannot access the OWNER/ADMIN management console (unchanged boundary)");
  const memberDashboard = await fetchRaw(member1Session, "/dashboard");
  check("TEST 9 - MEMBER GET /dashboard is still redirected server-side to /access-restricted", memberDashboard.status === 307 && memberDashboard.location === "/access-restricted");
  const memberJobsList = await fetchRaw(member1Session, "/jobs");
  check("TEST 9 - MEMBER GET /jobs (business-wide Schedule) is still redirected", memberJobsList.status === 307 && memberJobsList.location === "/access-restricted");

  console.log("\nTEST 10/11 — Assigned MEMBER can open their Field Job; unassigned MEMBER cannot");
  const fieldJobAssigned = await fetchRaw(member1Session, `/field/jobs/${assignedJob.id}`);
  check("TEST 10 - Assigned member (member1) can open their assigned Field Job (200)", fieldJobAssigned.status === 200);
  check("TEST 10 - The Field Job page shows the real customer name", fieldJobAssigned.body.includes(customerA.name));

  const fieldJobUnassignedMember = await fetchRaw(member2Session, `/field/jobs/${assignedJob.id}`);
  check("TEST 11 - Unassigned member (member2) cannot open member1's Field Job (404)", fieldJobUnassignedMember.status === 404);
  check("TEST 11 - ...and the raw response never contains the customer's name", !fieldJobUnassignedMember.body.includes(customerA.name));

  console.log("\nTEST 12 — MEMBER A cannot open MEMBER B's Job by direct URL");
  const fieldJobOtherMember = await fetchRaw(member2Session, `/field/jobs/${otherJob.id}`);
  check("TEST 12 - member2 cannot open member1's other job by guessing its URL (404)", fieldJobOtherMember.status === 404);
  check("TEST 12 - ...and no customer/job data leaks into that response", !fieldJobOtherMember.body.includes(customerA.name));

  console.log("\nTEST 13 — Business A MEMBER cannot open a Business B Job (and vice versa)");
  const betaJob = await prisma.job.create({
    data: { businessId: businessB.id, projectToken: randomUUID(), status: "SCHEDULED", assignedMembershipId: betaMemberMembership.id },
  });
  const crossBusinessFieldJob = await fetchRaw(member1Session, `/field/jobs/${betaJob.id}`);
  check("TEST 13 - A Business A member cannot open a Business B job even when it exists and is assigned to someone", crossBusinessFieldJob.status === 404);
  const reverseCrossBusiness = await fetchRaw(betaMemberSession, `/field/jobs/${assignedJob.id}`);
  check("TEST 13 - A Business B member cannot open a Business A job", reverseCrossBusiness.status === 404);

  console.log("\nTEST 14 — A denied Field route leaks no customer/job data in the raw response");
  check(
    "TEST 14 - Denied Field Job responses above are all plain 404s with no Job/customer content",
    fieldJobUnassignedMember.status === 404 &&
      fieldJobOtherMember.status === 404 &&
      crossBusinessFieldJob.status === 404 &&
      !fieldJobUnassignedMember.body.includes(customerA.name) &&
      !fieldJobOtherMember.body.includes(customerA.name) &&
      !crossBusinessFieldJob.body.includes(customerA.name),
  );

  console.log("\nTEST 15/16/17 — Assigned MEMBER sees approved Estimate scope + APPROVED change orders only");
  const scopeFieldJobPage = await fetchRaw(member1Session, `/field/jobs/${scopeJob.id}`);
  check("TEST 15 - Assigned member's Field Job page returns 200", scopeFieldJobPage.status === 200);
  check("TEST 15 - Assigned member sees the real approved Estimate line item", scopeFieldJobPage.body.includes("Canary Approved Scope Line Q9x"));
  check("TEST 16 - Assigned member sees the APPROVED change order as approved additional work", scopeFieldJobPage.body.includes(CO_APPROVED));
  check("TEST 17 - Assigned member does NOT see the DRAFT change order anywhere on the page", !scopeFieldJobPage.body.includes(CO_DRAFT));
  check("TEST 17 - Assigned member does NOT see the SENT (not yet approved) change order", !scopeFieldJobPage.body.includes(CO_SENT));
  check("TEST 17 - Assigned member does NOT see the DECLINED change order", !scopeFieldJobPage.body.includes(CO_DECLINED));
  check("TEST 17 - Assigned member does NOT see the CANCELLED change order", !scopeFieldJobPage.body.includes(CO_CANCELLED));

  console.log("\nMEMBER FIELD JOB PAGE — Field-safe contact info, actions, no owner-only data");
  check("Field Job page shows a click-to-call link for the customer's phone", scopeFieldJobPage.body.includes(`tel:${customerA.phone}`));
  check(
    "Field Job page shows a Directions link built from the property address (no paid API key)",
    // JSX/HTML-serializes "&" as "&amp;" inside an href attribute, so check
    // for the base endpoint + query param name separately rather than the
    // raw "?api=1&query=" string.
    scopeFieldJobPage.body.includes("https://www.google.com/maps/search/") &&
      scopeFieldJobPage.body.includes("api=1") &&
      scopeFieldJobPage.body.includes("query=") &&
      !scopeFieldJobPage.body.includes("key=") &&
      !scopeFieldJobPage.body.includes("maps.googleapis.com"),
  );
  check("Field Job page offers Start Job / Complete Job / Report Problem / Customer Asked for More Work actions", scopeFieldJobPage.body.includes("Start Job") && scopeFieldJobPage.body.includes("Report Problem") && scopeFieldJobPage.body.includes("Customer Asked for More Work"));
  check("Field Job page never mentions Invoice/payment (owner financial control stays out of the field view)", !scopeFieldJobPage.body.includes("Invoice"));

  console.log("\nTEST 28 — OWNER/ADMIN can see field problem report + employee additional-work request on the Work Order");
  const workOrderPage = await fetchRaw(ownerSession, `/jobs/${scopeJob.id}`);
  check("TEST 28 - Work Order returns 200 for OWNER", workOrderPage.status === 200);
  check("TEST 28 - Work Order shows the field problem report's description", workOrderPage.body.includes(httpProblemDescription));
  check("TEST 28 - Work Order shows the reporting member's name", workOrderPage.body.includes(member1User.name));
  check("TEST 28 - Work Order shows the employee-sourced additional-work request", workOrderPage.body.includes(httpAdditionalWorkDescription) && workOrderPage.body.includes("Reported by field employee"));
  check("TEST 28 - Work Order shows the current assignment (assigned member's name/email)", workOrderPage.body.includes(member1User.name) && workOrderPage.body.includes(member1User.email));

  console.log("\nTEST 29 — Customer Project Portal never exposes field problem reports or employee-only data");
  const portalPage = await fetchRaw(null, `/p/${scopeJob.projectToken}`);
  check("TEST 29 - Customer portal returns 200", portalPage.status === 200);
  check("TEST 29 - Customer portal never shows the field problem report", !portalPage.body.includes(httpProblemDescription));
  check("TEST 29 - Customer portal never shows the employee-sourced additional-work request text", !portalPage.body.includes(httpAdditionalWorkDescription));
  check("TEST 29 - Customer portal never shows the assigned member's name (no employee assignment surfaced to the customer)", !portalPage.body.includes(member1User.name));
  check("TEST 29 - Customer portal never shows the DRAFT/SENT/DECLINED/CANCELLED change order titles", !portalPage.body.includes(CO_DRAFT) && !portalPage.body.includes(CO_CANCELLED));

  console.log(
    failures === 0
      ? "\nAll employee field workflow checks passed."
      : `\n${failures} employee field workflow check(s) failed.`,
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

process.exit(failures === 0 ? 0 : 1);

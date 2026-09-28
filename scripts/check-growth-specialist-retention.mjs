/**
 * Growth specialist + Retention Recovery Center proofs.
 *
 * Run with:
 *   npm run test:growth-specialist-retention
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for Growth retention specialist checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError, CAPABILITIES, requireBusinessCapability } = await import("@/lib/authorization");
const {
  GROWTH_RETENTION_CONTEXT_CAPS,
  GROWTH_RETENTION_FACT_KEYS,
  GROWTH_RETENTION_NOT_AUTHORIZED_LIMITATION,
  getLastGrowthProjection,
  growthProjectionHasForbiddenFields,
  interpretGrowthSpecialist,
  loadCanonicalRecommendationCatalog,
  projectRetentionFromWorkspace,
  resetLastGrowthProjection,
  runGrowthSpecialist,
} = await import("@/lib/chief-of-staff");
const {
  DUE_OR_OVERDUE_FACT,
  FORBIDDEN_CADENCE_PATTERNS,
  FORBIDDEN_RETENTION_CLAIM_PATTERNS,
  NO_LATER_JOB_FACT,
  NO_REFERRAL_REQUEST_FACT,
  NO_REVIEW_REQUEST_FACT,
  RECORDED_FOLLOW_UP_FACT,
  RETENTION_CANDIDATE_LIMIT,
  RETENTION_ROUTE,
  hasSameBusinessReferralRequestForJob,
  hasSameBusinessReviewRequestForJob,
  loadRetentionRecoveryCenter,
  retentionFollowUpWriteAllowed,
  retentionTextHasForbiddenClaim,
  retentionTextHasInventedCadence,
} = await import("@/lib/growth/retention");
const { CUSTOMER_FOLLOW_UP_ORIGINS } = await import("@/lib/customer-follow-up-origin");
const { getSpecialistEntry } = await import("@/lib/chief-of-staff/registry");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const specialistSrc = readSrc("src/lib/chief-of-staff/growth-specialist.ts");
const retentionSrc = readSrc("src/lib/chief-of-staff/growth-retention.ts");
const runSrc = readSrc("src/lib/chief-of-staff/run.ts");
const querySrc = readSrc("src/lib/growth/retention/queries.ts");
const loadSrc = readSrc("src/lib/growth/retention/load.ts");
const allSrc = [specialistSrc, retentionSrc, runSrc].join("\n");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_growth_specialist_retention_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const adminUrl = new URL(baseUrl);
adminUrl.search = "";
const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
  encoding: "utf8",
});
if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
  console.warn(createDb.stderr || createDb.stdout);
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for Growth retention specialist test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });
await prisma.$executeRawUnsafe(`
  CREATE UNIQUE INDEX IF NOT EXISTS "CustomerFollowUp_retention_task_business_customer_job_key"
  ON "CustomerFollowUp"("businessId", "customerId", "jobId")
  WHERE "origin" = 'RETENTION_TASK' AND "jobId" IS NOT NULL
`);

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: "owner@example.com", name: "Owner" },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
    assertAttachable(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

async function entitleFounder(businessId) {
  await prisma.businessSaasSubscription.create({
    data: {
      businessId,
      status: "active",
      planCode: "FOUNDER",
      legacyExempt: true,
    },
  });
}

function daysAgo(days, now = new Date()) {
  return new Date(now.getTime() - days * 86_400_000);
}

const now = new Date("2026-09-28T18:00:00.000Z");

try {
  console.log("\nSTATIC — reuse center facts, no invented scores or actions");
  const entry = getSpecialistEntry("GROWTH");
  check("Growth role floor stays VIEW_REPORTS", entry.requiredRoleCapability === CAPABILITIES.VIEW_REPORTS);
  check(
    "Specialist runner reuses the center loader",
    retentionSrc.includes("loadRetentionRecoveryCenter") &&
      specialistSrc.includes("loadGrowthRetentionCenter") &&
      runSrc.includes("runGrowthSpecialist"),
  );
  check(
    "Canonical same-business absence queries stay in the center module",
    querySrc.includes("export async function hasSameBusinessReviewRequestForJob") &&
      querySrc.includes("export async function hasSameBusinessReferralRequestForJob") &&
      querySrc.includes("export async function hasLaterSameBusinessJob") &&
      querySrc.includes("where: { businessId, jobId }") &&
      !retentionSrc.includes("reviewRequest.findMany") &&
      !retentionSrc.includes("referralRequest.findMany"),
  );
  check(
    "Specialist does not invent a second discovery query",
    !retentionSrc.includes("job.findMany") &&
      !specialistSrc.includes("customerFollowUp.findMany") &&
      loadSrc.includes("export async function loadRetentionRecoveryCenter"),
  );
  check(
    "No churn, buying intent, or invented cadence",
    !FORBIDDEN_RETENTION_CLAIM_PATTERNS.some((pattern) => pattern.test(allSrc)) &&
      !FORBIDDEN_CADENCE_PATTERNS.some((pattern) => pattern.test(allSrc)) &&
      !/REACTIVATION_AFTER_DAYS/.test(retentionSrc) &&
      /Does not invent churn, buying intent, or a contact cadence/.test(retentionSrc),
  );
  check(
    "No autonomous follow-up, SMS, email, or Controlled AI writes",
    !/createCustomerFollowUp|recordRetentionFollowUpTask|createReviewRequest|createReferralRequest|createGrowthActionRequest|sendReviewRequest|sendCustomerFollowUp|composeCustomerCommunication/.test(
      allSrc,
    ) &&
      entry.forbiddenBehavior.includes("create-follow-up") &&
      entry.forbiddenBehavior.includes("invent-churn-score"),
  );
  check(
    "OWNER follow-up links stay on recorded customer, job, or follow-up task",
    retentionSrc.includes('ownerLink("CUSTOMER"') &&
      retentionSrc.includes('ownerLink("JOB"') &&
      retentionSrc.includes('"FOLLOW_UP_TASK"') &&
      retentionSrc.includes("RETENTION_ROUTE") &&
      RETENTION_ROUTE === "/growth/retention",
  );
  check(
    "Detail stays inside specialist bounds, not the full center scan",
    GROWTH_RETENTION_CONTEXT_CAPS.candidates === 4 &&
      GROWTH_RETENTION_CONTEXT_CAPS.followUps === 4 &&
      GROWTH_RETENTION_CONTEXT_CAPS.entityIds === 4 &&
      GROWTH_RETENTION_CONTEXT_CAPS.candidates < RETENTION_CANDIDATE_LIMIT,
  );

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-gsr-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Avery", email: `admin-gsr-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-gsr-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-gsr-${randomUUID()}@example.com`, passwordHash: "x" },
  });

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Growth Retention",
      slug: `alpha-gsr-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Growth Retention",
      slug: `beta-gsr-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });

  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerAccess = makeAccess(businessA.id, "OWNER", ownerMem.id, ownerUser.id);
  const adminAccess = makeAccess(businessA.id, "ADMIN", adminMem.id, adminUser.id);
  const memberAccess = makeAccess(businessA.id, "MEMBER", memberMem.id, memberUser.id);
  const betaAccess = makeAccess(businessB.id, "OWNER", betaMem.id, betaUser.id);

  await entitleFounder(businessA.id);
  await entitleFounder(businessB.id);

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner", email: "ada-secret@example.com", phone: "555-0100" },
  });
  const pastCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Past Parker" },
  });
  const followCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Followup Fay" },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });

  const extraNoReviewJobs = [];
  for (let i = 0; i < 6; i += 1) {
    const extraCustomer = await prisma.customer.create({
      data: { businessId: businessA.id, name: `No Review ${i + 1}` },
    });
    const job = await prisma.job.create({
      data: {
        businessId: businessA.id,
        customerId: extraCustomer.id,
        status: "COMPLETED",
        projectToken: randomUUID(),
        createdAt: daysAgo(30 + i, now),
      },
    });
    extraNoReviewJobs.push(job);
    await prisma.businessEvent.create({
      data: {
        businessId: businessA.id,
        type: "JOB_COMPLETED",
        subjectType: "JOB",
        subjectId: job.id,
        occurredAt: daysAgo(30 + i, now),
        idempotencyKey: `JOB_COMPLETED:${job.id}`,
      },
    });
  }

  const completedWithReview = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(20, now),
    },
  });
  await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      createdAt: daysAgo(2, now),
    },
  });
  const pastOnlyJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: pastCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(40, now),
    },
  });
  const followJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: followCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(12, now),
    },
  });
  const betaJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(5, now),
    },
  });
  const foreignLaterJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: pastCustomer.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
      createdAt: daysAgo(1, now),
    },
  });

  await prisma.businessEvent.create({
    data: {
      businessId: businessA.id,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: pastOnlyJob.id,
      occurredAt: daysAgo(40, now),
      idempotencyKey: `JOB_COMPLETED:${pastOnlyJob.id}`,
    },
  });
  await prisma.businessEvent.create({
    data: {
      businessId: businessA.id,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: followJob.id,
      occurredAt: daysAgo(12, now),
      idempotencyKey: `JOB_COMPLETED:${followJob.id}`,
    },
  });

  await prisma.reviewRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      jobId: completedWithReview.id,
      status: "SENT",
      createdByMembershipId: ownerMem.id,
    },
  });
  await prisma.reviewRequest.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      jobId: extraNoReviewJobs[0].id,
      status: "SENT",
      createdByMembershipId: betaMem.id,
    },
  });
  await prisma.referralRequest.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      jobId: pastOnlyJob.id,
      status: "SENT",
      createdByMembershipId: betaMem.id,
    },
  });

  const dueFollowUp = await prisma.customerFollowUp.create({
    data: {
      businessId: businessA.id,
      customerId: followCustomer.id,
      jobId: followJob.id,
      kind: "JOB_COMPLETE",
      status: "OPEN",
      origin: CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK,
      dueOn: daysAgo(1, now),
      notes: "SECRET FOLLOW-UP BODY",
    },
  });
  await prisma.customerFollowUp.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      jobId: betaJob.id,
      kind: "JOB_COMPLETE",
      status: "OPEN",
      origin: CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK,
      dueOn: daysAgo(1, now),
      notes: "BETA SECRET TASK",
    },
  });
  await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: followCustomer.id,
      summary: "Never estimated",
      status: "OPEN",
    },
  });

  console.log("\nAUTH — MEMBER blocked, ADMIN matches Growth gate");
  try {
    requireBusinessCapability(memberAccess, CAPABILITIES.VIEW_REPORTS);
    check("MEMBER remains blocked from VIEW_REPORTS", false);
  } catch (error) {
    check("MEMBER remains blocked from VIEW_REPORTS", error instanceof ForbiddenError);
  }
  try {
    await loadRetentionRecoveryCenter(prisma, { businessId: businessA.id, role: "MEMBER", now });
    check("MEMBER cannot load the retention center", false);
  } catch (error) {
    check("MEMBER cannot load the retention center", error instanceof ForbiddenError);
  }

  resetLastGrowthProjection();
  const catalogA = await loadCanonicalRecommendationCatalog(prisma, businessA.id);
  const memberResult = await runGrowthSpecialist({
    db: prisma,
    access: memberAccess,
    catalog: catalogA,
    question: "Which customers need retention follow-up?",
    now,
  });
  check("MEMBER Growth specialist is SKIPPED", memberResult.status === "SKIPPED");
  check("MEMBER skip reason is NOT_AUTHORIZED", memberResult.skipReason === "NOT_AUTHORIZED");
  check("MEMBER skip uses the Growth-gate limitation", memberResult.limitation === GROWTH_RETENTION_NOT_AUTHORIZED_LIMITATION);
  check("MEMBER receives no retention facts or links", memberResult.findings.length === 0 && memberResult.factKeys.length === 0);
  check("MEMBER does not receive a Growth projection", getLastGrowthProjection() == null);
  check(
    "ADMIN write gate stays OWNER-only",
    retentionFollowUpWriteAllowed("OWNER") === true &&
      retentionFollowUpWriteAllowed("ADMIN") === false &&
      retentionFollowUpWriteAllowed("MEMBER") === false,
  );

  console.log("\nFACTS — same-business center totals, wording, and OWNER links");
  const center = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    now,
  });
  resetLastGrowthProjection();
  const ownerResult = await runGrowthSpecialist({
    db: prisma,
    access: ownerAccess,
    catalog: catalogA,
    question: "Show customer retention and repeat-business facts.",
    now,
  });
  const projection = getLastGrowthProjection();
  const retention = projection?.retention;
  check("OWNER Growth specialist is OK", ownerResult.status === "OK");
  check("Retention projection reuses the center", Boolean(retention?.centerReused));
  check(
    "Specialist totals match the center exactly",
    Boolean(retention) &&
      retention.totals.noReviewRequest === center.totals.noReviewRequest &&
      retention.totals.noLaterJob === center.totals.noLaterJob &&
      retention.totals.dueOrOverdue === center.totals.dueOrOverdue &&
      retention.totals.recordedFollowUp === center.totals.recordedFollowUp &&
      retention.totals.noReferralRequest === center.totals.noReferralRequest &&
      retention.totals.incompleteJourney === center.totals.incompleteJourney,
  );
  check(
    "Fact keys carry the center totals",
    ownerResult.factKeys.includes(GROWTH_RETENTION_FACT_KEYS.noReviewRequest) &&
      ownerResult.factKeys.includes(GROWTH_RETENTION_FACT_KEYS.dueOrOverdue) &&
      ownerResult.factKeys.includes(GROWTH_RETENTION_FACT_KEYS.noLaterJob),
  );

  const noReviewFinding = ownerResult.findings.find((row) => row.key === GROWTH_RETENTION_FACT_KEYS.noReviewRequest);
  const laterFinding = ownerResult.findings.find((row) => row.key === GROWTH_RETENTION_FACT_KEYS.noLaterJob);
  const dueFinding = ownerResult.findings.find((row) => row.key === GROWTH_RETENTION_FACT_KEYS.dueOrOverdue);
  const recordedFinding = ownerResult.findings.find((row) => row.key === GROWTH_RETENTION_FACT_KEYS.recordedFollowUp);
  const referralFinding = ownerResult.findings.find((row) => row.key === GROWTH_RETENTION_FACT_KEYS.noReferralRequest);
  check("No-review finding uses the center fact", noReviewFinding?.summary.includes(NO_REVIEW_REQUEST_FACT) === true);
  check("No-later-job finding uses the center fact", laterFinding?.summary.includes(NO_LATER_JOB_FACT) === true);
  check("Due finding uses the center fact", dueFinding?.summary.includes(DUE_OR_OVERDUE_FACT) === true);
  check("Recorded follow-up finding uses the center fact", recordedFinding?.summary.includes(RECORDED_FOLLOW_UP_FACT) === true);
  check("No-referral finding uses the center fact", referralFinding?.summary.includes(NO_REFERRAL_REQUEST_FACT) === true);
  check(
    "SENT stay SENT and is not rewritten to DELIVERED",
    retention.recordedFollowUp.every((row) => row.status !== "SENT" || row.statusLabel === "SENT") &&
      !JSON.stringify(ownerResult).includes("DELIVERED"),
  );

  const dueLinks = dueFinding?.ownerLinks ?? [];
  check(
    "OWNER is linked to the recorded customer",
    dueLinks.some((link) => link.recordType === "CUSTOMER" && link.id === followCustomer.id && link.href === `/customers/${followCustomer.id}`),
  );
  check(
    "OWNER is linked to the recorded job",
    dueLinks.some((link) => link.recordType === "JOB" && link.id === followJob.id && link.href === `/jobs/${followJob.id}`),
  );
  check(
    "OWNER is linked to the recorded follow-up task",
    dueLinks.some(
      (link) =>
        link.recordType === "FOLLOW_UP_TASK" &&
        link.id === dueFollowUp.id &&
        link.href === `${RETENTION_ROUTE}?customerId=${encodeURIComponent(followCustomer.id)}`,
    ),
  );
  check(
    "Finding entity ids stay on recorded customer, job, or follow-up",
    (dueFinding?.entityIds ?? []).includes(dueFollowUp.id) &&
      (dueFinding?.entityIds ?? []).includes(followCustomer.id) &&
      (dueFinding?.entityIds ?? []).includes(followJob.id),
  );

  resetLastGrowthProjection();
  const adminResult = await runGrowthSpecialist({
    db: prisma,
    access: adminAccess,
    catalog: catalogA,
    question: "Show customer retention and repeat-business facts.",
    now,
  });
  const adminRetention = getLastGrowthProjection()?.retention;
  check("ADMIN Growth specialist is OK, matching the Growth gate", adminResult.status === "OK");
  check(
    "ADMIN sees the same center totals as OWNER",
    Boolean(adminRetention) &&
      adminRetention.totals.noReviewRequest === center.totals.noReviewRequest &&
      adminRetention.totals.dueOrOverdue === center.totals.dueOrOverdue &&
      adminRetention.totals.noLaterJob === center.totals.noLaterJob,
  );
  check("ADMIN still cannot write a retention follow-up", retentionFollowUpWriteAllowed(adminAccess.workspace.role) === false);

  console.log("\nISOLATION — foreign tenant rows do not change local truth");
  check(
    "Foreign ReviewRequest does not suppress a local no-review job",
    center.groups.noReviewRequest.some((row) => row.lastCompletedJobId === extraNoReviewJobs[0].id) &&
      (await hasSameBusinessReviewRequestForJob(prisma, businessA.id, extraNoReviewJobs[0].id)) === false &&
      (await hasSameBusinessReviewRequestForJob(prisma, businessB.id, extraNoReviewJobs[0].id)) === true,
  );
  check(
    "Foreign later Job does not change local no-later-job truth",
    center.groups.noLaterJob.some((row) => row.customerId === pastCustomer.id) &&
      foreignLaterJob.customerId === pastCustomer.id &&
      (await hasSameBusinessReferralRequestForJob(prisma, businessA.id, pastOnlyJob.id)) === false,
  );
  const serialized = JSON.stringify(retention);
  check("Beta customer id is absent from the Alpha projection", !serialized.includes(betaCustomer.id));
  check("Beta follow-up notes are absent", !serialized.includes("BETA SECRET TASK") && !serialized.includes("SECRET FOLLOW-UP BODY"));
  check("Ada email and phone stay out of the projection", !serialized.includes("ada-secret@example.com") && !serialized.includes("555-0100"));
  check("Projection has no forbidden fields", !growthProjectionHasForbiddenFields(projection));

  resetLastGrowthProjection();
  const betaCatalog = await loadCanonicalRecommendationCatalog(prisma, businessB.id);
  const betaResult = await runGrowthSpecialist({
    db: prisma,
    access: betaAccess,
    catalog: betaCatalog,
    question: "Show customer retention facts.",
    now,
  });
  const betaRetention = getLastGrowthProjection()?.retention;
  check("Beta specialist stays on the Beta tenant", betaResult.status === "OK" && Boolean(betaRetention));
  check("Beta projection includes the Beta follow-up", betaRetention.dueOrOverdue.some((row) => row.customerId === betaCustomer.id));
  check("Beta projection omits Alpha follow-up", !JSON.stringify(betaRetention).includes(dueFollowUp.id));

  resetLastGrowthProjection();
  const foreignHint = await runGrowthSpecialist({
    db: prisma,
    access: ownerAccess,
    catalog: catalogA,
    question: "Show customer retention facts.",
    entityHints: { customerId: betaCustomer.id },
    now,
  });
  const foreignRetention = getLastGrowthProjection()?.retention;
  check(
    "Foreign customer hint returns empty retention groups",
    foreignHint.status === "OK" &&
      Boolean(foreignRetention) &&
      foreignRetention.totals.noReviewRequest === 0 &&
      foreignRetention.totals.dueOrOverdue === 0 &&
      foreignRetention.noReviewRequest.length === 0,
  );

  console.log("\nBOUNDS — specialist detail is capped while totals stay the center totals");
  check(
    "No-review detail is bounded to 4",
    retention.noReviewRequest.length <= GROWTH_RETENTION_CONTEXT_CAPS.candidates &&
      center.totals.noReviewRequest > GROWTH_RETENTION_CONTEXT_CAPS.candidates &&
      retention.totals.noReviewRequest === center.totals.noReviewRequest,
  );
  check(
    "Entity ids and owner links stay bounded",
    (noReviewFinding?.entityIds?.length ?? 0) <= GROWTH_RETENTION_CONTEXT_CAPS.entityIds &&
      (noReviewFinding?.ownerLinks?.length ?? 0) <= GROWTH_RETENTION_CONTEXT_CAPS.ownerLinks &&
      (dueFinding?.ownerLinks?.length ?? 0) <= GROWTH_RETENTION_CONTEXT_CAPS.ownerLinks,
  );
  check(
    "Sync interpreter still works without loading the center",
    interpretGrowthSpecialist(catalogA, "Which lost leads can I recover?").status === "OK",
  );

  const ownerText = ownerResult.findings.map((row) => row.summary).join("\n");
  check("Specialist wording has no forbidden claims", retentionTextHasForbiddenClaim(ownerText) === false);
  check("Specialist wording has no invented cadence", retentionTextHasInventedCadence(ownerText) === false);

  const projected = projectRetentionFromWorkspace(center);
  check(
    "Direct projection helper matches the specialist retention slice",
    projected.totals.noReviewRequest === retention.totals.noReviewRequest &&
      projected.noReviewRequest.length === retention.noReviewRequest.length &&
      projected.dueOrOverdue[0]?.followUpId === retention.dueOrOverdue[0]?.followUpId,
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\n${failures} Growth specialist retention check(s) failed.`);
  process.exit(1);
}
console.log("\nGrowth specialist retention checks passed.");

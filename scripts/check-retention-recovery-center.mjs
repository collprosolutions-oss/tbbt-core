/**
 * Customer Retention & Repeat-Business Recovery Center proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-retention-recovery-center.mjs
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
  console.error("Failed to generate Prisma client for retention recovery checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError, canAccessManagementConsole } = await import("@/lib/authorization");
const { RECOVERY_QUEUE_LABELS } = await import("@/lib/growth");
const {
  FORBIDDEN_CADENCE_PATTERNS,
  FORBIDDEN_RETENTION_CLAIM_PATTERNS,
  NO_LATER_JOB_FACT,
  NO_REVIEW_REQUEST_FACT,
  RETENTION_CANDIDATE_LIMIT,
  RETENTION_NO_CADENCE_MESSAGE,
  RETENTION_READ_ONLY_MESSAGE,
  daysSinceInBusinessTimeZone,
  followUpStatusIsDeliveredRewrite,
  formatLastCompletedAge,
  hasLaterSameBusinessJob,
  hasSameBusinessReferralRequestForJob,
  hasSameBusinessReviewRequestForJob,
  loadRetentionRecoveryCenter,
  recordedFollowUpStatusLabel,
  resolveOwnedRetentionCustomer,
  retentionCenterRoleAllowed,
  retentionTextHasForbiddenClaim,
  retentionTextHasInventedCadence,
  retentionWorkspaceText,
  sameTenantRecordHref,
} = await import("@/lib/growth/retention");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const libFiles = [
  "src/lib/growth/retention/constants.ts",
  "src/lib/growth/retention/types.ts",
  "src/lib/growth/retention/age.ts",
  "src/lib/growth/retention/access.ts",
  "src/lib/growth/retention/links.ts",
  "src/lib/growth/retention/queries.ts",
  "src/lib/growth/retention/wording.ts",
  "src/lib/growth/retention/load.ts",
  "src/lib/growth/retention/index.ts",
];
const uiFiles = [
  "src/app/(app)/growth/retention/page.tsx",
  "src/components/growth/retention/retention-center.tsx",
];
const allRetentionSource = [...libFiles, ...uiFiles].map(readSrc).join("\n");
const displayRetentionSource = [...libFiles.filter((file) => !file.endsWith("constants.ts")), ...uiFiles]
  .map(readSrc)
  .join("\n");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_retention_recovery_center_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for retention recovery test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function daysAgo(days, now = new Date()) {
  return new Date(now.getTime() - days * 86_400_000);
}

try {
  console.log("\nSTATIC — wording, cadence, schema, mutations, auth");
  check(
    "Completed-job / no review fact is exact",
    NO_REVIEW_REQUEST_FACT ===
      "Recorded completed work exists and no same-business ReviewRequest is recorded for that completed job.",
  );
  check("Past-customer label is factual", NO_LATER_JOB_FACT === "Past customer with no later job recorded");
  check(
    "Candidate wording does not say likely/churn/ready-to-buy",
    !FORBIDDEN_RETENTION_CLAIM_PATTERNS.some((pattern) => pattern.test(displayRetentionSource)),
  );
  check(
    "No arbitrary 30/60/90-day contact rule is invented",
    !FORBIDDEN_CADENCE_PATTERNS.some((pattern) => pattern.test(displayRetentionSource)) &&
      !/REACTIVATION_AFTER_DAYS/.test(allRetentionSource) &&
      /does not invent a universal re-engagement interval/.test(RETENTION_NO_CADENCE_MESSAGE),
  );
  check(
    "Read-only center does not automate SMS/email/review/referral",
    /does not send SMS or email/.test(RETENTION_READ_ONLY_MESSAGE) &&
      !/createReviewRequest|createReferralRequest|createCustomerFollowUp|sendReviewRequest|sendCustomerFollowUp|createGrowthActionRequest/.test(
        allRetentionSource,
      ),
  );
  check(
    "No message bodies are selected or rendered",
    !/requestText|messageBody|lastEmailStatus|lastSmsStatus|\bnotes\b/.test(allRetentionSource),
  );
  check(
    "SENT is never rewritten to DELIVERED",
    recordedFollowUpStatusLabel("SENT") === "SENT" &&
      followUpStatusIsDeliveredRewrite("SENT", recordedFollowUpStatusLabel("SENT")) === false,
  );
  check(
    "No schema / migrate / Prisma model edits in this center",
    !/model ReviewRequest|prisma migrate|schema\.prisma/.test(allRetentionSource),
  );
  const loadSrc = readSrc("src/lib/growth/retention/load.ts");
  check(
    "Loader is read-only on page load",
    !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(loadSrc) &&
      /mutationsOnLoad: false/.test(loadSrc),
  );
  check(
    "Candidate discovery is bounded",
    loadSrc.includes("take: RETENTION_CANDIDATE_LIMIT") && RETENTION_CANDIDATE_LIMIT === 50,
  );
  check(
    "Absence claims use scoped job/business queries",
    loadSrc.includes("reviewRequests: {") &&
      loadSrc.includes("some: { businessId: input.businessId }") &&
      readSrc("src/lib/growth/retention/queries.ts").includes("where: { businessId, jobId }") &&
      readSrc("src/lib/growth/retention/queries.ts").includes("createdAt: { gt: afterCreatedAt }"),
  );
  const pageSrc = readSrc("src/app/(app)/growth/retention/page.tsx");
  check(
    "Page calls requireManagementPageAccess before loading",
    pageSrc.includes("requireManagementPageAccess()") &&
      pageSrc.indexOf("requireManagementPageAccess") < pageSrc.indexOf("loadRetentionRecoveryCenter"),
  );
  check("MEMBER cannot access the management console", canAccessManagementConsole("MEMBER") === false);
  check("OWNER and ADMIN may open the center", retentionCenterRoleAllowed("OWNER") && retentionCenterRoleAllowed("ADMIN"));
  check("MEMBER role is denied by the retention gate", retentionCenterRoleAllowed("MEMBER") === false);
  check(
    "Incomplete journey reuses Growth recovery labels",
    loadSrc.includes("buildRecoveryQueue") && loadSrc.includes("RECOVERY_QUEUE_LABELS"),
  );
  check("Growth specialist was not modified", !libFiles.includes("src/lib/chief-of-staff/growth-specialist.ts"));

  const now = new Date("2026-09-27T06:30:00.000Z");
  check(
    "Age uses Business.timezone calendar days (LA is still the prior evening)",
    daysSinceInBusinessTimeZone(new Date("2026-09-26T10:00:00.000Z"), now, "America/Los_Angeles") === 0 &&
      daysSinceInBusinessTimeZone(new Date("2026-09-26T10:00:00.000Z"), now, "America/New_York") === 1,
  );
  check("Factual age copy is 'Last completed job: 94 days ago'", formatLastCompletedAge(94) === "Last completed job: 94 days ago");

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Retention",
      slug: `alpha-ret-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Retention",
      slug: `beta-ret-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-ret-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-ret-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-ret-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "OWNER" },
  });

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const repeatCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Repeat Rivera" },
  });
  const followCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Followup Fay" },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });

  const completedNoReview = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(94, now),
    },
  });
  const completedWithReview = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(40, now),
    },
  });
  const laterLocalJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      createdAt: daysAgo(10, now),
    },
  });
  const pastOnlyJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: repeatCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(94, now),
    },
  });
  const followJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: followCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(20, now),
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
      customerId: repeatCustomer.id,
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
      occurredAt: new Date("2026-09-26T10:00:00.000Z"),
      idempotencyKey: `JOB_COMPLETED:${pastOnlyJob.id}`,
    },
  });
  await prisma.businessEvent.create({
    data: {
      businessId: businessA.id,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: completedNoReview.id,
      occurredAt: daysAgo(94, now),
      idempotencyKey: `JOB_COMPLETED:${completedNoReview.id}`,
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
      jobId: completedNoReview.id,
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
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: repeatCustomer.id,
      jobId: pastOnlyJob.id,
      status: "PAID",
      total: 240,
      paidAt: daysAgo(90, now),
      paymentMethod: "CASH",
    },
  });
  await prisma.customerFollowUp.create({
    data: {
      businessId: businessA.id,
      customerId: followCustomer.id,
      jobId: followJob.id,
      kind: "JOB_COMPLETE",
      status: "SENT",
      sentAt: daysAgo(2, now),
      notes: "SECRET FOLLOW-UP BODY",
      lastEmailStatus: "DELIVERED",
      lastSmsStatus: "DELIVERED",
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

  console.log("\nTEST — MEMBER denied and foreign ids fail closed");
  try {
    await loadRetentionRecoveryCenter(prisma, {
      businessId: businessA.id,
      role: "MEMBER",
      now,
    });
    check("MEMBER denied", false);
  } catch (error) {
    check("MEMBER denied", error instanceof ForbiddenError);
  }

  const foreignCustomer = await resolveOwnedRetentionCustomer(prisma, businessA.id, betaCustomer.id);
  check("Foreign customer id fails closed", foreignCustomer === null);

  const foreignWorkspace = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    customerId: betaCustomer.id,
    now,
  });
  check(
    "Foreign customer filter returns no candidates",
    foreignWorkspace.totals.noReviewRequest === 0 &&
      foreignWorkspace.totals.noLaterJob === 0 &&
      foreignWorkspace.totals.recordedFollowUp === 0 &&
      foreignWorkspace.groups.noReviewRequest.length === 0,
  );

  console.log("\nTEST — factual recovery groups and tenant isolation");
  const workspace = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    now,
  });

  const noReviewIds = workspace.groups.noReviewRequest.map((row) => row.lastCompletedJobId);
  check(
    "Completed job with no ReviewRequest is surfaced factually",
    noReviewIds.includes(completedNoReview.id) &&
      workspace.groups.noReviewRequest.some((row) => row.fact === NO_REVIEW_REQUEST_FACT),
  );
  check(
    "Same job with recorded ReviewRequest is not in the no-review group",
    !noReviewIds.includes(completedWithReview.id),
  );
  check(
    "Foreign-tenant ReviewRequest does not suppress the local candidate",
    noReviewIds.includes(completedNoReview.id) &&
      (await hasSameBusinessReviewRequestForJob(prisma, businessA.id, completedNoReview.id)) === false &&
      (await hasSameBusinessReviewRequestForJob(prisma, businessB.id, completedNoReview.id)) === true,
  );
  check("Beta completed job is not a local candidate", !noReviewIds.includes(betaJob.id));

  const noLaterIds = workspace.groups.noLaterJob.map((row) => row.customerId);
  check(
    "Past customer with no later local Job is identified",
    noLaterIds.includes(repeatCustomer.id) &&
      workspace.groups.noLaterJob.some((row) => row.fact === NO_LATER_JOB_FACT),
  );
  check(
    "A real later Job removes no-later-job truth",
    !noLaterIds.includes(customer.id) &&
      (await hasLaterSameBusinessJob(
        prisma,
        businessA.id,
        customer.id,
        completedWithReview.createdAt,
        completedWithReview.id,
      )) === true,
  );
  check(
    "Foreign later Job does not change local truth",
    noLaterIds.includes(repeatCustomer.id) &&
      (await hasLaterSameBusinessJob(
        prisma,
        businessA.id,
        repeatCustomer.id,
        pastOnlyJob.createdAt,
        pastOnlyJob.id,
      )) === false &&
      foreignLaterJob.customerId === repeatCustomer.id,
  );

  const pastRow = workspace.groups.noLaterJob.find((row) => row.customerId === repeatCustomer.id);
  check(
    "Age since last completed job uses Business.timezone",
    pastRow?.daysSinceCompleted === 0 &&
      pastRow.lastCompletedAgeLabel === "Last completed job: today" &&
      workspace.timeZone === "America/Los_Angeles",
  );
  check(
    "Last invoice status is recorded without a payment method",
    pastRow?.lastInvoiceStatus === "PAID" &&
      !JSON.stringify(pastRow).includes("CASH") &&
      !JSON.stringify(workspace).includes("paymentMethod"),
  );

  const followRow = workspace.groups.recordedFollowUp.find((row) => row.customerId === followCustomer.id);
  check(
    "CustomerFollowUp status is presented only from recorded truth",
    followRow?.status === "SENT" && followRow.statusLabel === "SENT",
  );
  check("SENT does not become DELIVERED", followRow?.statusLabel !== "DELIVERED");
  check(
    "No message bodies exposed",
    !JSON.stringify(workspace).includes("SECRET FOLLOW-UP BODY") &&
      !JSON.stringify(workspace).includes("DELIVERED"),
  );

  check(
    "Foreign ReferralRequest does not suppress a local no-referral candidate",
    workspace.groups.noReferralRequest.some((row) => row.lastCompletedJobId === pastOnlyJob.id) &&
      (await hasSameBusinessReferralRequestForJob(prisma, businessA.id, pastOnlyJob.id)) === false,
  );
  check(
    "Incomplete journey reuses Growth NEVER_ESTIMATED",
    workspace.groups.incompleteJourney.some(
      (row) => row.queue === "NEVER_ESTIMATED" && row.queueLabel === RECOVERY_QUEUE_LABELS.NEVER_ESTIMATED,
    ),
  );

  const text = retentionWorkspaceText(workspace);
  check("Serialized candidate wording has no forbidden claims", retentionTextHasForbiddenClaim(text) === false);
  check("Serialized candidate wording has no invented cadence", retentionTextHasInventedCadence(text) === false);

  const customerLink = pastRow?.links.find((link) => link.label === "Open customer");
  const jobLink = pastRow?.links.find((link) => link.label === "Open job");
  check(
    "Links are same-tenant verified",
    customerLink?.href === `/customers/${repeatCustomer.id}` &&
      jobLink?.href === `/jobs/${pastOnlyJob.id}` &&
      sameTenantRecordHref("customer", betaCustomer.id, businessB.id, businessA.id, "OWNER") === null &&
      !JSON.stringify(workspace.groups).includes(betaCustomer.id),
  );
  check("Workspace is read-only and mutation-free on load", workspace.readOnly === true && workspace.mutationsOnLoad === false);

  console.log("\nTEST — bounded discovery and exact absence outside the window");
  const extraJobs = [];
  for (let i = 0; i < 55; i += 1) {
    extraJobs.push(
      prisma.job.create({
        data: {
          businessId: businessA.id,
          customerId: followCustomer.id,
          status: "COMPLETED",
          projectToken: randomUUID(),
          createdAt: daysAgo(i + 1, now),
        },
      }),
    );
  }
  await Promise.all(extraJobs);
  const oldestExtra = await prisma.job.findFirst({
    where: { businessId: businessA.id, customerId: followCustomer.id, status: "COMPLETED" },
    orderBy: { createdAt: "asc" },
  });
  const bounded = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    now,
  });
  check(
    "Candidate discovery is bounded to 50",
    bounded.groups.noReviewRequest.length <= RETENTION_CANDIDATE_LIMIT &&
      bounded.candidateLimit === 50,
  );
  check(
    "Absence for a job outside the displayed window is still an exact scoped check",
    oldestExtra != null &&
      (await hasSameBusinessReviewRequestForJob(prisma, businessA.id, oldestExtra.id)) === false &&
      bounded.groups.noReviewRequest.some((row) => row.lastCompletedJobId === oldestExtra.id) === false,
  );

  console.log("\nTEST — no automatic writes during a second load");
  const reviewCountBefore = await prisma.reviewRequest.count({ where: { businessId: businessA.id } });
  const followCountBefore = await prisma.customerFollowUp.count({ where: { businessId: businessA.id } });
  await loadRetentionRecoveryCenter(prisma, { businessId: businessA.id, role: "OWNER", now });
  const reviewCountAfter = await prisma.reviewRequest.count({ where: { businessId: businessA.id } });
  const followCountAfter = await prisma.customerFollowUp.count({ where: { businessId: businessA.id } });
  check("No review/follow-up rows created on load", reviewCountBefore === reviewCountAfter && followCountBefore === followCountAfter);
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\n${failures} retention recovery check(s) failed.`);
  process.exit(1);
}
console.log("\nRetention recovery center checks passed.");

/**
 * OWNER customer-reported callback against a completed same-business job.
 *
 * Dedicated database: tbbt_job_callback_test
 *
 * Proves OWNER authorization, tenant isolation, duplicate open-callback
 * handling, append-only status history, and recorded-warranty display
 * without inventing coverage. Does not invoice, schedule a job, or
 * message the customer.
 *
 * Run with:
 *   npm run test:job-callback
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for job-callback checks.");
  process.exit(generateEarly.status ?? 1);
}

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const { joinLineDescriptionFromParts, splitLineDescription } = await import(
  "@/lib/estimate-line-scope"
);
const {
  JOB_CALLBACK_ALREADY_OPEN_MESSAGE,
  JOB_CALLBACK_COMPLETED_JOB_MESSAGE,
  JOB_CALLBACK_COVERAGE_REFUSED_MESSAGE,
  JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE,
  JOB_CALLBACK_OUTCOME_ALREADY_RECORDED_MESSAGE,
  JOB_CALLBACK_OWNER_ONLY_MESSAGE,
  JOB_CALLBACK_OWNER_WORKFLOW_MESSAGE,
  JOB_CALLBACK_REVIEW_FIRST_MESSAGE,
  JOB_CALLBACK_WARRANTY_DISCLAIMER,
  jobCallbackWriteAllowed,
} = await import("@/lib/job-callback");
const { loadJobCallbackReview } = await import("@/lib/job-callback-data");
const {
  countBusinessCommunications,
  countBusinessInvoices,
  countBusinessJobs,
  countBusinessPayments,
  jobCallbackErrorMessage,
  recordCustomerReportedCallback,
  recordCustomerReportedCallbackOutcome,
  reviewCustomerReportedCallback,
} = await import("@/lib/job-callback-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the job-callback check.");
  process.exit(1);
}

const sourceUrl = new URL(baseUrl);
const databaseHost = sourceUrl.hostname.toLowerCase();
if (databaseHost !== "localhost" && databaseHost !== "127.0.0.1" && databaseHost !== "::1") {
  console.error(
    "Job-callback checks refuse a remote DATABASE_URL. Host must be localhost, 127.0.0.1, or ::1.",
  );
  process.exit(1);
}

const testDbName = "tbbt_job_callback_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const adminUrl = new URL(baseUrl);
adminUrl.search = "";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const clients = [];

function trackClient(client) {
  clients.push(client);
  return client;
}

function createWriteBarrier(expected, timeoutMs) {
  let arrived = 0;
  let released = false;
  let release;
  let fail;
  const held = new Promise((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const timer = setTimeout(() => {
    if (!released) {
      fail(new Error(`Race barrier timed out after ${timeoutMs}ms`));
    }
  }, timeoutMs);
  return {
    async arriveAndWait() {
      arrived += 1;
      if (arrived >= expected) {
        released = true;
        clearTimeout(timer);
        release();
      }
      await held;
    },
  };
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

async function expectThrow(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: `${role.toLowerCase()}@example.com`, name: role },
      business: { id: businessId, name: "Callback Co" },
    },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

const featureFiles = [
  "src/lib/job-callback.ts",
  "src/lib/job-callback-ops.ts",
  "src/lib/job-callback-data.ts",
  "src/app/actions/job-callback.ts",
  "src/components/jobs/job-callback-panel.tsx",
];
const featureSrc = featureFiles.map(read).join("\n");
const opsSrc = read("src/lib/job-callback-ops.ts");
const dataSrc = read("src/lib/job-callback-data.ts");
const actionSrc = read("src/app/actions/job-callback.ts");
const formSrc = read("src/components/jobs/job-callback-panel.tsx");
const pageSrc = read("src/app/(app)/jobs/[jobId]/page.tsx");
const portalSrc = read("src/app/p/[token]/page.tsx");
const additionalWorkSrc = read("src/lib/additional-work-request.ts");
const schemaSrc = read("prisma/schema.prisma");
const migrationSrc = read("prisma/migrations/20260929010900_job_callback/migration.sql");

console.log("\nSTATIC — OWNER-only, trade-neutral, no invoice/job/message, no invented coverage");
check(
  "OWNER-only write gate",
  jobCallbackWriteAllowed("OWNER") === true &&
    jobCallbackWriteAllowed("ADMIN") === false &&
    jobCallbackWriteAllowed("MEMBER") === false &&
    opsSrc.includes("requireBusinessRole(access, \"OWNER\")") &&
    opsSrc.includes("JOB_CALLBACK_OWNER_ONLY_MESSAGE"),
);
check(
  "Copy stays trade-neutral and does not invent coverage",
  !/handyman|cleaning|re-clean|corrective clean|pressure wash/i.test(featureSrc) &&
    !/COVERED|NOT_COVERED|IN_WARRANTY|OUT_OF_WARRANTY/.test(
      formSrc + actionSrc + pageSrc,
    ) &&
    JOB_CALLBACK_WARRANTY_DISCLAIMER.includes("does not determine coverage") &&
    JOB_CALLBACK_OWNER_WORKFLOW_MESSAGE.includes("does not create an invoice") &&
    JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE.includes("No warranty terms are recorded"),
);
check(
  "Write path does not invoice, schedule, or message",
  !opsSrc.includes("invoice.create") &&
    !opsSrc.includes("persistDraftInvoice") &&
    !opsSrc.includes("completeJobAndSendInvoice") &&
    !opsSrc.includes("tx.job.create") &&
    !opsSrc.includes("payment.create") &&
    !opsSrc.includes("notifyCustomer") &&
    !opsSrc.includes("sendCustomer") &&
    !opsSrc.includes("emitAndProcessBusinessEvent") &&
    !actionSrc.includes("invoice.create") &&
    !actionSrc.includes("notifyCustomer") &&
    !formSrc.includes("Create invoice") &&
    !formSrc.includes("Schedule"),
);
check(
  "Partial unique open-callback index and append-only events",
  schemaSrc.includes("model JobCallback") &&
    schemaSrc.includes("model JobCallbackEvent") &&
    schemaSrc.includes("Application code must never update or delete an existing row") &&
    migrationSrc.includes("JobCallback_open_job_key") &&
    migrationSrc.includes("WHERE \"status\" IN ('RECORDED', 'UNDER_REVIEW')") &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSrc) &&
    opsSrc.includes("jobCallbackEvent.create") &&
    !opsSrc.includes("jobCallbackEvent.update") &&
    !opsSrc.includes("jobCallbackEvent.delete"),
);
check(
  "Review loader is mutation-free, scoped, and shows recorded warranty only",
  dataSrc.includes("...access.scope") &&
    dataSrc.includes('category: "WARRANTY"') &&
    dataSrc.includes("warrantyTermLooksRecorded") &&
    dataSrc.includes("JOB_CALLBACK_WARRANTY_DISCLAIMER") &&
    !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(dataSrc),
);
check(
  "Work Order hosts the OWNER panel; portal and additional-work stay separate",
  pageSrc.includes("JobCallbackPanel") &&
    pageSrc.includes("Customer-reported callback") &&
    pageSrc.includes("Does not invent coverage") &&
    formSrc.includes("Recorded warranty terms") &&
    formSrc.includes("Status history") &&
    !portalSrc.includes("job-callback") &&
    !portalSrc.includes("JobCallbackPanel") &&
    !additionalWorkSrc.includes("jobCallback") &&
    !additionalWorkSrc.includes("JobCallback"),
);

try {
  const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
    encoding: "utf8",
  });
  if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
    throw new Error(createDb.stderr || createDb.stdout || "Failed to create job-callback test database.");
  }

  const push = spawnSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
  );
  if (push.status !== 0) {
    throw new Error("Failed to push schema for job-callback test database.");
  }

  const prisma = trackClient(new PrismaClient({ datasourceUrl: testUrl }));
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "JobCallback_open_job_key"
    ON "JobCallback"("businessId", "jobId")
    WHERE "status" IN ('RECORDED', 'UNDER_REVIEW')
  `);

  const suffix = randomUUID().slice(0, 8);
  const ownerUser = await prisma.user.create({
    data: { name: "Owen", email: `owner-cb-${suffix}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ada", email: `admin-cb-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mel", email: `member-cb-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-cb-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerCUser = await prisma.user.create({
    data: { name: "Cam", email: `gamma-cb-${suffix}@example.com`, passwordHash: "x" },
  });

  const businessA = await prisma.business.create({
    data: { name: "Alpha Callback", slug: `alpha-cb-${suffix}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Callback", slug: `beta-cb-${suffix}`, tradeCode: "CLEANING" },
  });
  const businessC = await prisma.business.create({
    data: { name: "Gamma Callback", slug: `gamma-cb-${suffix}`, tradeCode: "HANDYMAN" },
  });

  const memOwnerA = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memAdminA = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memMemberA = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const memOwnerB = await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const memOwnerC = await prisma.membership.create({
    data: { userId: ownerCUser.id, businessId: businessC.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", memOwnerA.id, ownerUser.id);
  const adminA = makeAccess(businessA.id, "ADMIN", memAdminA.id, adminUser.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memMemberA.id, memberUser.id);
  const ownerB = makeAccess(businessB.id, "OWNER", memOwnerB.id, ownerBUser.id);
  const ownerC = makeAccess(businessC.id, "OWNER", memOwnerC.id, ownerCUser.id);

  async function createJob(businessId, options = {}) {
    const { status = "COMPLETED", withEstimateTerms = false } = options;
    const customer = await prisma.customer.create({
      data: {
        businessId,
        name: "Callback Customer",
        email: `cust-${randomUUID().slice(0, 6)}@example.com`,
      },
    });
    const request = await prisma.serviceRequest.create({
      data: {
        businessId,
        customerId: customer.id,
        description: "Completed work",
      },
    });
    const estimate = await prisma.estimate.create({
      data: {
        businessId,
        customerId: customer.id,
        serviceRequestId: request.id,
        status: "APPROVED",
        publicToken: randomUUID(),
        total: 250,
      },
    });
    const version = await prisma.estimateVersion.create({
      data: {
        businessId,
        estimateId: estimate.id,
        versionNumber: 1,
        total: 250,
        laborMinimumWaived: false,
        laborMinimumAdjustment: 0,
        approvedAt: new Date(),
      },
    });
    const policyDescription = withEstimateTerms
      ? joinLineDescriptionFromParts(splitLineDescription("Interior paint"), {
          customerPolicies: [
            {
              id: "core-customer-supplied-materials",
              title: "Customer-Supplied Materials",
              body: "When the customer supplies materials, the business is not responsible for warranty issues caused by those materials.",
            },
            {
              id: "core-payment",
              title: "Payment",
              body: "Payment amounts and due dates are those shown on this estimate.",
            },
          ],
        })
      : "Interior paint";
    await prisma.estimateVersionLineItem.create({
      data: {
        businessId,
        estimateVersionId: version.id,
        description: policyDescription,
        quantity: 1,
        unitPrice: 250,
        total: 250,
        type: "LABOR",
      },
    });
    return prisma.job.create({
      data: {
        businessId,
        customerId: customer.id,
        estimateId: estimate.id,
        approvedEstimateVersionId: version.id,
        status,
        projectToken: randomUUID(),
      },
    });
  }

  const completedA = await createJob(businessA.id, { withEstimateTerms: true });
  const inProgressA = await createJob(businessA.id, { status: "IN_PROGRESS" });
  const completedB = await createJob(businessB.id);

  await prisma.businessVaultRecord.create({
    data: {
      businessId: businessA.id,
      title: "Ninety-day workmanship note",
      category: "WARRANTY",
      notes: "Owner-recorded: workmanship callback window as written on the paper ticket.",
      effectiveOn: "2026-08-01",
      expiresOn: "2026-10-30",
      recordStatus: "ACTIVE",
      createdByMembershipId: memOwnerA.id,
    },
  });
  await prisma.businessVaultRecord.create({
    data: {
      businessId: businessA.id,
      title: "General liability",
      category: "INSURANCE",
      notes: "Not a warranty.",
      recordStatus: "ACTIVE",
      createdByMembershipId: memOwnerA.id,
    },
  });
  await prisma.businessVaultRecord.create({
    data: {
      businessId: businessB.id,
      title: "Beta-only warranty binder",
      category: "WARRANTY",
      notes: "Must never appear on Alpha.",
      recordStatus: "ACTIVE",
      createdByMembershipId: memOwnerB.id,
    },
  });

  const agreement = await prisma.businessAgreement.create({
    data: {
      businessId: businessA.id,
      agreementType: "CUSTOMER_AGREEMENT",
      title: "Customer work agreement",
      lifecycleStatus: "SIGNED",
      createdByMembershipId: memOwnerA.id,
    },
  });
  const signedVersion = await prisma.businessAgreementVersion.create({
    data: {
      businessId: businessA.id,
      agreementId: agreement.id,
      versionNumber: 1,
      representationStatus: "SIGNED_FINAL",
      answersJson: JSON.stringify({
        warranty: "Owner-stated: callback for workmanship if recorded on the signed packet.",
      }),
      createdByMembershipId: memOwnerA.id,
      lockedAt: new Date(),
    },
  });
  await prisma.businessAgreement.update({
    where: { id: agreement.id },
    data: { signedVersionId: signedVersion.id },
  });

  const invoicesBefore = await countBusinessInvoices(prisma, businessA.id);
  const jobsBefore = await countBusinessJobs(prisma, businessA.id);
  const paymentsBefore = await countBusinessPayments(prisma, businessA.id);
  const commsBefore = await countBusinessCommunications(prisma, businessA.id);

  console.log("\nAUTH — ADMIN and MEMBER cannot write");
  await expectThrow(
    "ADMIN cannot record a callback",
    () =>
      recordCustomerReportedCallback(prisma, adminA, {
        jobId: completedA.id,
        description: "Paint chip",
        reportedVia: "PHONE",
      }),
    (error) =>
      error instanceof ForbiddenError &&
      jobCallbackErrorMessage(error, "") === JOB_CALLBACK_OWNER_ONLY_MESSAGE,
  );
  await expectThrow(
    "MEMBER cannot record a callback",
    () =>
      recordCustomerReportedCallback(prisma, memberA, {
        jobId: completedA.id,
        description: "Paint chip",
        reportedVia: "PHONE",
      }),
    (error) => error instanceof ForbiddenError,
  );

  console.log("\nELIGIBILITY — completed same-business job only");
  await expectThrow(
    "In-progress job is refused",
    () =>
      recordCustomerReportedCallback(prisma, ownerA, {
        jobId: inProgressA.id,
        description: "Too early",
        reportedVia: "PHONE",
      }),
    (error) =>
      error.name === "JobCallbackError" &&
      error.message === JOB_CALLBACK_COMPLETED_JOB_MESSAGE,
  );
  await expectThrow(
    "Foreign completed job is isolated",
    () =>
      recordCustomerReportedCallback(prisma, ownerA, {
        jobId: completedB.id,
        description: "Cross tenant",
        reportedVia: "PHONE",
      }),
    (error) =>
      error.name === "JobCallbackError" && error.message === "That job could not be found.",
  );

  console.log("\nRECORD / REVIEW / OUTCOME — status history");
  const recorded = await recordCustomerReportedCallback(prisma, ownerA, {
    jobId: completedA.id,
    description: "Customer called about a paint chip on the door.",
    reportedVia: "PHONE",
  });
  check("First record is RECORDED", recorded.status === "RECORDED" && recorded.jobId === completedA.id);

  await expectThrow(
    "Outcome before review is refused",
    () =>
      recordCustomerReportedCallbackOutcome(prisma, ownerA, {
        callbackId: recorded.id,
        outcome: "RECORDED_ONLY",
      }),
    (error) => error.message === JOB_CALLBACK_REVIEW_FIRST_MESSAGE,
  );

  const reviewed = await reviewCustomerReportedCallback(prisma, ownerA, {
    callbackId: recorded.id,
  });
  check("Review moves status to UNDER_REVIEW", reviewed.callback.status === "UNDER_REVIEW");
  const reviewedAgain = await reviewCustomerReportedCallback(prisma, ownerA, {
    callbackId: recorded.id,
  });
  check("Duplicate review is unchanged", reviewedAgain.unchanged === true);

  await expectThrow(
    "Coverage outcome is refused",
    () =>
      recordCustomerReportedCallbackOutcome(prisma, ownerA, {
        callbackId: recorded.id,
        outcome: "COVERED",
      }),
    (error) => error.message === JOB_CALLBACK_COVERAGE_REFUSED_MESSAGE,
  );

  const outcome = await recordCustomerReportedCallbackOutcome(prisma, ownerA, {
    callbackId: recorded.id,
    outcome: "WILL_FOLLOW_UP",
    outcomeNotes: "Owner will call back later. Not a coverage decision.",
  });
  check(
    "Outcome is recorded operationally",
    outcome.callback.status === "OUTCOME_RECORDED" &&
      outcome.callback.outcome === "WILL_FOLLOW_UP",
  );
  const outcomeAgain = await recordCustomerReportedCallbackOutcome(prisma, ownerA, {
    callbackId: recorded.id,
    outcome: "WILL_FOLLOW_UP",
    outcomeNotes: "Owner will call back later. Not a coverage decision.",
  });
  check("Same outcome retry is unchanged", outcomeAgain.unchanged === true);
  await expectThrow(
    "Different outcome after close is refused",
    () =>
      recordCustomerReportedCallbackOutcome(prisma, ownerA, {
        callbackId: recorded.id,
        outcome: "NO_RETURN_VISIT",
      }),
    (error) => error.message === JOB_CALLBACK_OUTCOME_ALREADY_RECORDED_MESSAGE,
  );

  const events = await prisma.jobCallbackEvent.findMany({
    where: { businessId: businessA.id, callbackId: recorded.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  check(
    "Status history is append-only RECORDED → REVIEWED → OUTCOME_RECORDED",
    events.length === 3 &&
      events[0].eventType === "RECORDED" &&
      events[0].toStatus === "RECORDED" &&
      events[1].eventType === "REVIEWED" &&
      events[1].fromStatus === "RECORDED" &&
      events[1].toStatus === "UNDER_REVIEW" &&
      events[2].eventType === "OUTCOME_RECORDED" &&
      events[2].fromStatus === "UNDER_REVIEW" &&
      events[2].toStatus === "OUTCOME_RECORDED",
  );

  console.log("\nDUPLICATE — one open callback per job");
  const secondJob = await createJob(businessA.id);
  const firstOpen = await recordCustomerReportedCallback(prisma, ownerA, {
    jobId: secondJob.id,
    description: "First open report",
    reportedVia: "TEXT",
  });
  await expectThrow(
    "Second open callback on the same job is refused",
    () =>
      recordCustomerReportedCallback(prisma, ownerA, {
        jobId: secondJob.id,
        description: "Duplicate open report",
        reportedVia: "TEXT",
      }),
    (error) => error.message === JOB_CALLBACK_ALREADY_OPEN_MESSAGE,
  );

  const concurrentJob = await createJob(businessA.id);
  const raceA = trackClient(new PrismaClient({ datasourceUrl: testUrl }));
  const raceB = trackClient(new PrismaClient({ datasourceUrl: testUrl }));
  const barrier = createWriteBarrier(2, 5000);
  const concurrent = await Promise.allSettled([
    (async () => {
      await barrier.arriveAndWait();
      return recordCustomerReportedCallback(raceA, ownerA, {
        jobId: concurrentJob.id,
        description: "Concurrent A",
        reportedVia: "EMAIL",
      });
    })(),
    (async () => {
      await barrier.arriveAndWait();
      return recordCustomerReportedCallback(raceB, ownerA, {
        jobId: concurrentJob.id,
        description: "Concurrent B",
        reportedVia: "EMAIL",
      });
    })(),
  ]);
  const concurrentOk = concurrent.filter((row) => row.status === "fulfilled");
  const concurrentDenied = concurrent.filter(
    (row) =>
      row.status === "rejected" &&
      row.reason?.message === JOB_CALLBACK_ALREADY_OPEN_MESSAGE,
  );
  const concurrentCount = await prisma.jobCallback.count({
    where: { businessId: businessA.id, jobId: concurrentJob.id },
  });
  check(
    "Concurrent duplicate-submit creates exactly one open callback",
    concurrentCount === 1 &&
      concurrentOk.length === 1 &&
      concurrentDenied.length === 1,
  );

  console.log("\nISOLATION — other-business callbacks and warranty terms stay hidden");
  const foreignReview = await loadJobCallbackReview(prisma, ownerA, completedB.id);
  check("Foreign job review is null", foreignReview === null);
  const betaRecorded = await recordCustomerReportedCallback(prisma, ownerB, {
    jobId: completedB.id,
    description: "Beta customer called",
    reportedVia: "PHONE",
  });
  const alphaSeesBeta = await prisma.jobCallback.findMany({
    where: { ...ownerA.scope, id: betaRecorded.id },
  });
  check("Alpha scope cannot read Beta callback", alphaSeesBeta.length === 0);
  await expectThrow(
    "Alpha cannot review Beta callback",
    () => reviewCustomerReportedCallback(prisma, ownerA, { callbackId: betaRecorded.id }),
    (error) => /not in the authorized business/i.test(error.message ?? ""),
  );

  console.log("\nWARRANTY — display recorded terms only");
  const review = await loadJobCallbackReview(prisma, ownerA, completedA.id);
  const titles = (review?.warrantyTerms ?? []).map((term) => term.title);
  check(
    "Recorded vault and agreement warranty terms appear",
    titles.includes("Ninety-day workmanship note") &&
      titles.includes("Customer work agreement") &&
      review?.warrantyTerms.some((term) =>
        /workmanship callback window/.test(term.body ?? ""),
      ) === true,
  );
  check(
    "Insurance and foreign warranty are not invented as coverage",
    !titles.includes("General liability") &&
      !titles.includes("Beta-only warranty binder") &&
      !review?.warrantyTerms.some((term) => /invented|automatically covered/i.test(term.body ?? "")) &&
      review?.warrantyDisclaimer === JOB_CALLBACK_WARRANTY_DISCLAIMER,
  );
  check(
    "Approved-estimate warranty language is shown as recorded, payment term is not",
    review?.warrantyTerms.some((term) =>
      term.source === "ESTIMATE" && /warranty issues caused by those materials/.test(term.body ?? ""),
    ) === true &&
      !review?.warrantyTerms.some((term) => term.title === "Payment"),
  );

  const emptyJob = await createJob(businessC.id);
  const emptyReview = await loadJobCallbackReview(prisma, ownerC, emptyJob.id);
  check(
    "Business without recorded warranty terms says none are recorded",
    emptyReview?.warrantyTerms.length === 0 &&
      emptyReview?.noWarrantyTermsMessage === JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE,
  );

  console.log("\nSIDE EFFECTS — no invoice, extra job, payment, or customer message");
  check(
    "Invoice / job / payment / communication counts unchanged for Alpha writes",
    (await countBusinessInvoices(prisma, businessA.id)) === invoicesBefore &&
      (await countBusinessJobs(prisma, businessA.id)) ===
        jobsBefore + 2 &&
      (await countBusinessPayments(prisma, businessA.id)) === paymentsBefore &&
      (await countBusinessCommunications(prisma, businessA.id)) === commsBefore,
  );
  check(
    "Closed callback allows a later new callback on the same completed job",
    firstOpen.status === "RECORDED" &&
      (await recordCustomerReportedCallback(prisma, ownerA, {
        jobId: completedA.id,
        description: "Second report after the first outcome.",
        reportedVia: "IN_PERSON",
      })).status === "RECORDED",
  );

  console.log(
    failed === 0
      ? `\nAll job-callback checks passed (${passed}).`
      : `\n${failed} job-callback check(s) failed.`,
  );
} catch (error) {
  console.error(error);
  failed += 1;
} finally {
  for (const client of clients) {
    try {
      await client.$disconnect();
    } catch {
      // Keep dropping the dedicated test database even if one disconnect fails.
    }
  }
  spawnSync(
    "psql",
    [adminUrl.toString(), "-c", `DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`],
    { encoding: "utf8" },
  );
}

process.exitCode = failed === 0 ? 0 : 1;

/**
 * OWNER job-specific aftercare on a completed same-business job.
 *
 * Dedicated local disposable database (name prefix tbbt_job_aftercare).
 *
 * Proves OWNER authorization, token and tenant isolation, publish/revoke
 * behavior, and historical wording. Displays recorded warranty terms as
 * stored. Does not invent coverage, send a customer message, or invoice.
 *
 * Run with:
 *   npm run test:job-aftercare
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for job-aftercare checks.");
  process.exit(generateEarly.status ?? 1);
}

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const { joinLineDescriptionFromParts, splitLineDescription } = await import(
  "@/lib/estimate-line-scope"
);
const {
  JOB_AFTERCARE_COMPLETED_JOB_MESSAGE,
  JOB_AFTERCARE_DRAFT_SAVED_MESSAGE,
  JOB_AFTERCARE_INSTRUCTIONS_REQUIRED_MESSAGE,
  JOB_AFTERCARE_JOB_REQUIRED_MESSAGE,
  JOB_AFTERCARE_NOT_PUBLISHED_MESSAGE,
  JOB_AFTERCARE_NOTHING_TO_PUBLISH_MESSAGE,
  JOB_AFTERCARE_OWNER_ONLY_MESSAGE,
  JOB_AFTERCARE_OWNER_WORKFLOW_MESSAGE,
  JOB_AFTERCARE_PORTAL_DESCRIPTION,
  JOB_AFTERCARE_PUBLISHED_MESSAGE,
  JOB_AFTERCARE_UNAVAILABLE_MESSAGE,
  JOB_AFTERCARE_UNPUBLISHED_MESSAGE,
  jobAftercareWriteAllowed,
  missingJobAftercareSchema,
} = await import("@/lib/job-aftercare");
const {
  loadJobAftercareReview,
  loadPublishedAftercareForProjectToken,
} = await import("@/lib/job-aftercare-data");
const {
  countBusinessCommunications,
  countBusinessInvoices,
  countBusinessJobs,
  countBusinessPayments,
  jobAftercareErrorMessage,
  jobAftercareTestHooks,
  publishJobAftercare,
  saveJobAftercareDraft,
  unpublishJobAftercare,
} = await import("@/lib/job-aftercare-ops");
const { ProjectAftercare } = await import("@/components/portal/project-aftercare");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const {
  JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE,
  JOB_CALLBACK_WARRANTY_DISCLAIMER,
} = await import("@/lib/job-callback");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the job-aftercare check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "job-aftercare dedicated local database");

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

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: `${role.toLowerCase()}@example.com`, name: role },
      business: { id: businessId, name: "Aftercare Co" },
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
  "src/lib/job-aftercare.ts",
  "src/lib/job-aftercare-ops.ts",
  "src/lib/job-aftercare-data.ts",
  "src/app/actions/job-aftercare.ts",
  "src/components/jobs/job-aftercare-panel.tsx",
  "src/components/portal/project-aftercare.tsx",
];
const featureSrc = featureFiles.map(read).join("\n");
const opsSrc = read("src/lib/job-aftercare-ops.ts");
const dataSrc = read("src/lib/job-aftercare-data.ts");
const actionSrc = read("src/app/actions/job-aftercare.ts");
const formSrc = read("src/components/jobs/job-aftercare-panel.tsx");
const portalComponentSrc = read("src/components/portal/project-aftercare.tsx");
const pageSrc = read("src/app/(app)/jobs/[jobId]/page.tsx");
const portalSrc = read("src/app/p/[token]/page.tsx");
const schemaSrc = read("prisma/schema.prisma");
const migrationSrc = read(
  "prisma/migrations/20261001180000_job_aftercare_instruction/migration.sql",
);
const navSrc = read("src/components/record-nav.tsx");

console.log("\nSTATIC — OWNER-only, explicit publish, no message, recorded warranty only");
check(
  "OWNER-only write gate",
  jobAftercareWriteAllowed("OWNER") === true &&
    jobAftercareWriteAllowed("ADMIN") === false &&
    jobAftercareWriteAllowed("MEMBER") === false &&
    opsSrc.includes("requireBusinessRole(access, \"OWNER\")") &&
    opsSrc.includes("JOB_AFTERCARE_OWNER_ONLY_MESSAGE"),
);
check(
  "Copy stays trade-neutral and does not invent coverage",
  !/handyman|cleaning|re-clean|corrective clean|pressure wash/i.test(featureSrc) &&
    !/COVERED|NOT_COVERED|IN_WARRANTY|OUT_OF_WARRANTY/.test(
      formSrc + actionSrc + pageSrc + portalComponentSrc,
    ) &&
    JOB_CALLBACK_WARRANTY_DISCLAIMER.includes("does not determine coverage") &&
    JOB_AFTERCARE_OWNER_WORKFLOW_MESSAGE.includes("does not send a message") &&
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
    !formSrc.includes("Schedule") &&
    JOB_AFTERCARE_DRAFT_SAVED_MESSAGE.includes("No customer message") &&
    JOB_AFTERCARE_PUBLISHED_MESSAGE.includes("No customer message") &&
    JOB_AFTERCARE_UNPUBLISHED_MESSAGE.includes("No customer message"),
);
check(
  "Additive aftercare tables and append-only events; Job columns untouched",
  schemaSrc.includes("model JobAftercareInstruction") &&
    schemaSrc.includes("model JobAftercareEvent") &&
    schemaSrc.includes("Application code must never update or delete an existing row") &&
    schemaSrc.includes("ownerNotes") &&
    schemaSrc.includes("publishedInstructions") &&
    migrationSrc.includes('CREATE TABLE IF NOT EXISTS "JobAftercareInstruction"') &&
    migrationSrc.includes('CREATE TABLE IF NOT EXISTS "JobAftercareEvent"') &&
    !migrationSrc.includes('ALTER TABLE "Job"') &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSrc) &&
    opsSrc.includes("jobAftercareEvent.create") &&
    !opsSrc.includes("jobAftercareEvent.update") &&
    !opsSrc.includes("jobAftercareEvent.delete"),
);
check(
  "Owner loader is mutation-free; token loader is published-only",
  dataSrc.includes("...access.scope") &&
    dataSrc.includes("loadRecordedWarrantyTerms") &&
    dataSrc.includes("JOB_CALLBACK_WARRANTY_DISCLAIMER") &&
    dataSrc.includes('status: "PUBLISHED"') &&
    dataSrc.includes("where: { projectToken: token }") &&
    !dataSrc.includes("draftInstructions: true") === false &&
    dataSrc.includes("publishedInstructions: true") &&
    !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(dataSrc),
);
check(
  "Loaders degrade on missing aftercare tables (P2021/P2022); writes fail closed",
  missingJobAftercareSchema({ code: "P2021" }) &&
    missingJobAftercareSchema({ code: "P2022" }) &&
    !missingJobAftercareSchema({ code: "P2002" }) &&
    !missingJobAftercareSchema(new Error("Can't reach database server")) &&
    dataSrc.includes("missingJobAftercareSchema") &&
    dataSrc.includes("if (missingJobAftercareSchema(error)) return null") &&
    opsSrc.includes("JOB_AFTERCARE_UNAVAILABLE_MESSAGE") &&
    opsSrc.includes("rethrowAftercareWriteError") &&
    jobAftercareErrorMessage({ code: "P2021" }, "fallback") ===
      JOB_AFTERCARE_UNAVAILABLE_MESSAGE,
);
check(
  "Unpublish locks the job but does not require COMPLETED",
  /unpublishJobAftercare[\s\S]*requireOwnedLockedJob/.test(opsSrc) &&
    !/unpublishJobAftercare[\s\S]*requireCompletedOwnedJob/.test(opsSrc) &&
    !/unpublishJobAftercare[\s\S]*completedSameBusinessJobEligible/.test(opsSrc) &&
    formSrc.includes("Already-published instructions can still be unpublished") &&
    formSrc.includes("review.aftercare?.status === \"PUBLISHED\""),
);
check(
  "Work Order hosts the OWNER panel; portal reads published only; no global nav change",
  pageSrc.includes("JobAftercarePanel") &&
    pageSrc.includes("Job aftercare instructions") &&
    pageSrc.includes("Does not invent coverage") &&
    formSrc.includes("Recorded warranty terms") &&
    formSrc.includes("Wording history") &&
    formSrc.includes("Private owner notes") &&
    portalSrc.includes("loadPublishedAftercareForProjectToken") &&
    portalSrc.includes("ProjectAftercare") &&
    portalComponentSrc.includes("JOB_AFTERCARE_PORTAL_HEADING") &&
    !portalComponentSrc.includes("ownerNotes") &&
    !portalComponentSrc.includes("draftInstructions") &&
    !navSrc.includes("aftercare") &&
    !navSrc.includes("Aftercare"),
);

console.log("\nBEHAVIOR — published aftercare text is escaped");
const xssPayload = `<script>alert("xss")</script>`;
const aftercareHtml = renderToStaticMarkup(
  createElement(ProjectAftercare, {
    aftercare: {
      jobId: "job-xss",
      businessId: "biz-xss",
      instructions: xssPayload,
      publishedAt: null,
    },
    timeZone: "UTC",
  }),
);
check(
  "ProjectAftercare escapes script text instead of embedding HTML",
  aftercareHtml.includes("&lt;script&gt;") &&
    !aftercareHtml.includes("<script>") &&
    !aftercareHtml.includes(xssPayload) &&
    !portalComponentSrc.includes("dangerouslySetInnerHTML"),
);

let session;
try {
  session = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_job_aftercare",
    setProcessEnv: true,
  });
  const prisma = session.prisma;
  check(
    "Dedicated local disposable database opened",
    Boolean(session.testDbName?.startsWith("tbbt_job_aftercare_")),
  );

  const suffix = randomUUID().slice(0, 8);
  const ownerUser = await prisma.user.create({
    data: { name: "Owen", email: `owner-ac-${suffix}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ada", email: `admin-ac-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mel", email: `member-ac-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-ac-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerCUser = await prisma.user.create({
    data: { name: "Cam", email: `gamma-ac-${suffix}@example.com`, passwordHash: "x" },
  });

  const businessA = await prisma.business.create({
    data: { name: "Alpha Aftercare", slug: `alpha-ac-${suffix}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Aftercare", slug: `beta-ac-${suffix}`, tradeCode: "CLEANING" },
  });
  const businessC = await prisma.business.create({
    data: { name: "Gamma Aftercare", slug: `gamma-ac-${suffix}`, tradeCode: "HANDYMAN" },
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
    const { status = "COMPLETED", withEstimateTerms = false, token } = options;
    const customer = await prisma.customer.create({
      data: {
        businessId,
        name: "Aftercare Customer",
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
        projectToken: token ?? randomUUID(),
      },
    });
  }

  const tokenA = `portal-a-${suffix}`;
  const tokenA2 = `portal-a2-${suffix}`;
  const tokenB = `portal-b-${suffix}`;
  const completedA = await createJob(businessA.id, {
    withEstimateTerms: true,
    token: tokenA,
  });
  const completedA2 = await createJob(businessA.id, { token: tokenA2 });
  const inProgressA = await createJob(businessA.id, { status: "IN_PROGRESS" });
  const completedB = await createJob(businessB.id, { token: tokenB });

  await prisma.businessVaultRecord.create({
    data: {
      businessId: businessA.id,
      title: "Ninety-day workmanship note",
      category: "WARRANTY",
      notes: "Owner-recorded: workmanship aftercare window as written on the paper ticket.",
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
        warranty: "Owner-stated: aftercare for workmanship if recorded on the signed packet.",
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
    "ADMIN cannot save a draft",
    () =>
      saveJobAftercareDraft(prisma, adminA, {
        jobId: completedA.id,
        instructions: "Keep the caulk dry.",
      }),
    (error) =>
      error instanceof ForbiddenError &&
      jobAftercareErrorMessage(error, "") === JOB_AFTERCARE_OWNER_ONLY_MESSAGE,
  );
  await expectThrow(
    "MEMBER cannot publish",
    () => publishJobAftercare(prisma, memberA, { jobId: completedA.id }),
    (error) => error instanceof ForbiddenError,
  );
  await expectThrow(
    "ADMIN cannot unpublish",
    () => unpublishJobAftercare(prisma, adminA, { jobId: completedA.id }),
    (error) => error instanceof ForbiddenError,
  );

  console.log("\nELIGIBILITY — completed same-business job only");
  await expectThrow(
    "In-progress job is refused",
    () =>
      saveJobAftercareDraft(prisma, ownerA, {
        jobId: inProgressA.id,
        instructions: "Too early",
      }),
    (error) =>
      error.name === "JobAftercareError" &&
      error.message === JOB_AFTERCARE_COMPLETED_JOB_MESSAGE,
  );
  await expectThrow(
    "Foreign completed job is isolated",
    () =>
      saveJobAftercareDraft(prisma, ownerA, {
        jobId: completedB.id,
        instructions: "Cross tenant",
      }),
    (error) =>
      error.name === "JobAftercareError" &&
      error.message === "That job could not be found.",
  );
  await expectThrow(
    "Empty instructions are refused",
    () =>
      saveJobAftercareDraft(prisma, ownerA, {
        jobId: completedA.id,
        instructions: "   ",
      }),
    (error) => error.message === JOB_AFTERCARE_INSTRUCTIONS_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "Publish without a draft is refused",
    () => publishJobAftercare(prisma, ownerA, { jobId: completedA2.id }),
    (error) => error.message === JOB_AFTERCARE_NOTHING_TO_PUBLISH_MESSAGE,
  );

  console.log("\nPUBLISH / REVISE / REVOKE — historical wording");
  const firstWording = "Keep the caulk dry for 24 hours.";
  const privateNote = "Owner reminder: customer used leftover tubes.";
  const drafted = await saveJobAftercareDraft(prisma, ownerA, {
    jobId: completedA.id,
    instructions: firstWording,
    ownerNotes: privateNote,
  });
  check(
    "First save is DRAFT",
    drafted.aftercare.status === "DRAFT" &&
      drafted.aftercare.draftInstructions === firstWording &&
      drafted.aftercare.ownerNotes === privateNote &&
      drafted.aftercare.publishedInstructions == null,
  );

  const tokenBeforePublish = await loadPublishedAftercareForProjectToken(prisma, tokenA);
  check("Token cannot read an unpublished draft", tokenBeforePublish === null);

  const ownerDraftReview = await loadJobAftercareReview(prisma, ownerA, completedA.id);
  const ownerDraftJson = JSON.stringify(ownerDraftReview);
  check(
    "OWNER review includes draft and private notes",
    ownerDraftReview?.aftercare?.draftInstructions === firstWording &&
      ownerDraftReview?.aftercare?.ownerNotes === privateNote &&
      ownerDraftJson.includes(privateNote),
  );

  const published = await publishJobAftercare(prisma, ownerA, { jobId: completedA.id });
  check(
    "Explicit publish copies draft wording",
    published.aftercare.status === "PUBLISHED" &&
      published.aftercare.publishedInstructions === firstWording,
  );

  const tokenPublished = await loadPublishedAftercareForProjectToken(prisma, tokenA);
  const tokenPublishedJson = JSON.stringify(tokenPublished);
  check(
    "Token reads only published wording for that job",
    tokenPublished?.jobId === completedA.id &&
      tokenPublished?.businessId === businessA.id &&
      tokenPublished?.instructions === firstWording &&
      !tokenPublishedJson.includes(privateNote) &&
      !tokenPublishedJson.includes("draftInstructions") &&
      !tokenPublishedJson.includes("ownerNotes"),
  );

  const secondWording = "Keep the caulk dry for 48 hours. Avoid bleach.";
  const revised = await saveJobAftercareDraft(prisma, ownerA, {
    jobId: completedA.id,
    instructions: secondWording,
    ownerNotes: "Do not tell the customer about the leftover tubes.",
  });
  check(
    "Revise keeps published wording until republish",
    revised.aftercare.status === "PUBLISHED" &&
      revised.aftercare.draftInstructions === secondWording &&
      revised.aftercare.publishedInstructions === firstWording,
  );
  const tokenStillFirst = await loadPublishedAftercareForProjectToken(prisma, tokenA);
  check(
    "Token still sees the published wording after a draft revise",
    tokenStillFirst?.instructions === firstWording &&
      !JSON.stringify(tokenStillFirst).includes(secondWording) &&
      !JSON.stringify(tokenStillFirst).includes("leftover tubes"),
  );

  const republished = await publishJobAftercare(prisma, ownerA, { jobId: completedA.id });
  check(
    "Republish replaces the customer-facing wording",
    republished.aftercare.publishedInstructions === secondWording,
  );
  const tokenSecond = await loadPublishedAftercareForProjectToken(prisma, tokenA);
  check("Token sees the new published wording", tokenSecond?.instructions === secondWording);

  const unpublished = await unpublishJobAftercare(prisma, ownerA, {
    jobId: completedA.id,
  });
  check(
    "Unpublish clears the live published snapshot",
    unpublished.aftercare.status === "UNPUBLISHED" &&
      unpublished.aftercare.publishedInstructions == null &&
      unpublished.aftercare.draftInstructions === secondWording,
  );
  check(
    "Token cannot read revoked instructions",
    (await loadPublishedAftercareForProjectToken(prisma, tokenA)) === null,
  );
  await saveJobAftercareDraft(prisma, ownerA, {
    jobId: completedA2.id,
    instructions: "Sister-job draft only.",
    ownerNotes: "Hidden sister note.",
  });
  await expectThrow(
    "Unpublish of a never-published draft is refused",
    () => unpublishJobAftercare(prisma, ownerA, { jobId: completedA2.id }),
    (error) => error.message === JOB_AFTERCARE_NOT_PUBLISHED_MESSAGE,
  );

  const historyReview = await loadJobAftercareReview(prisma, ownerA, completedA.id);
  const snapshots = (historyReview?.history ?? []).map((event) => event.instructionsSnapshot);
  const eventTypes = (historyReview?.history ?? []).map((event) => event.eventType);
  check(
    "History keeps drafted, revised, published, and unpublished wording",
    eventTypes.includes("DRAFTED") &&
      eventTypes.includes("REVISED") &&
      eventTypes.filter((type) => type === "PUBLISHED").length === 2 &&
      eventTypes.includes("UNPUBLISHED") &&
      snapshots.includes(firstWording) &&
      snapshots.includes(secondWording) &&
      historyReview?.history.some(
        (event) =>
          event.eventType === "UNPUBLISHED" && event.instructionsSnapshot === secondWording,
      ) === true,
  );
  check(
    "History never stores private owner notes",
    !(historyReview?.history ?? []).some((event) =>
      (event.instructionsSnapshot ?? "").includes("leftover tubes"),
    ),
  );

  console.log("\nTOKEN / TENANT ISOLATION");
  check(
    "Wrong token is empty",
    (await loadPublishedAftercareForProjectToken(prisma, "missing-token")) === null &&
      (await loadPublishedAftercareForProjectToken(prisma, " ")) === null,
  );
  await publishJobAftercare(prisma, ownerA, { jobId: completedA.id });
  const sisterToken = await loadPublishedAftercareForProjectToken(prisma, tokenA2);
  check(
    "Same-business sister token cannot read this job's published aftercare",
    sisterToken === null,
  );
  const betaToken = await loadPublishedAftercareForProjectToken(prisma, tokenB);
  check("Foreign-business token cannot read Alpha aftercare", betaToken === null);
  const foreignReview = await loadJobAftercareReview(prisma, ownerA, completedB.id);
  check("Foreign job owner review is null", foreignReview === null);
  await saveJobAftercareDraft(prisma, ownerB, {
    jobId: completedB.id,
    instructions: "Beta-only aftercare.",
    ownerNotes: "Beta private note.",
  });
  await publishJobAftercare(prisma, ownerB, { jobId: completedB.id });
  const alphaSeesBeta = await prisma.jobAftercareInstruction.findMany({
    where: { ...ownerA.scope, jobId: completedB.id },
  });
  check("Alpha scope cannot read Beta aftercare", alphaSeesBeta.length === 0);
  await expectThrow(
    "Alpha cannot publish Beta aftercare",
    () => publishJobAftercare(prisma, ownerA, { jobId: completedB.id }),
    (error) =>
      error.name === "JobAftercareError" &&
      error.message === JOB_AFTERCARE_JOB_REQUIRED_MESSAGE,
  );
  const alphaTokenAfterBeta = await loadPublishedAftercareForProjectToken(prisma, tokenA);
  check(
    "Alpha token still only sees Alpha published wording",
    alphaTokenAfterBeta?.instructions === secondWording &&
      !JSON.stringify(alphaTokenAfterBeta).includes("Beta-only"),
  );
  const betaPublished = await loadPublishedAftercareForProjectToken(prisma, tokenB);
  check(
    "Beta token sees only Beta published wording",
    betaPublished?.jobId === completedB.id &&
      betaPublished?.instructions === "Beta-only aftercare." &&
      !JSON.stringify(betaPublished).includes(secondWording),
  );

  console.log("\nWARRANTY — display recorded terms only");
  const review = await loadJobAftercareReview(prisma, ownerA, completedA.id);
  const titles = (review?.warrantyTerms ?? []).map((term) => term.title);
  check(
    "Recorded vault and agreement warranty terms appear as stored",
    titles.includes("Ninety-day workmanship note") &&
      titles.includes("Customer work agreement") &&
      review?.warrantyTerms.some((term) =>
        /workmanship aftercare window/.test(term.body ?? ""),
      ) === true &&
      review?.warrantyTerms.some((term) => term.expiresOn === "2026-10-30") === true,
  );
  check(
    "Insurance and foreign warranty are not invented as coverage or expiration",
    !titles.includes("General liability") &&
      !titles.includes("Beta-only warranty binder") &&
      !review?.warrantyTerms.some((term) =>
        /invented|automatically covered|still in effect|expired/i.test(term.body ?? ""),
      ) &&
      review?.warrantyDisclaimer === JOB_CALLBACK_WARRANTY_DISCLAIMER,
  );
  check(
    "Approved-estimate warranty language is shown as recorded, payment term is not",
    review?.warrantyTerms.some(
      (term) =>
        term.source === "ESTIMATE" &&
        /warranty issues caused by those materials/.test(term.body ?? ""),
    ) === true && !review?.warrantyTerms.some((term) => term.title === "Payment"),
  );
  const emptyJob = await createJob(businessC.id);
  const emptyReview = await loadJobAftercareReview(prisma, ownerC, emptyJob.id);
  check(
    "Business without recorded warranty terms says none are recorded",
    emptyReview?.warrantyTerms.length === 0 &&
      emptyReview?.noWarrantyTermsMessage === JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE,
  );
  const tokenHasNoWarranty = await loadPublishedAftercareForProjectToken(prisma, tokenA);
  check(
    "Token payload does not include warranty, drafts, or owner notes",
    tokenHasNoWarranty != null &&
      !("warrantyTerms" in tokenHasNoWarranty) &&
      !("ownerNotes" in tokenHasNoWarranty) &&
      !("draftInstructions" in tokenHasNoWarranty) &&
      !JSON.stringify(tokenHasNoWarranty).includes("Ninety-day") &&
      !JSON.stringify(tokenHasNoWarranty).includes("leftover"),
  );

  console.log("\nSIDE EFFECTS — no invoice, extra job, payment, or customer message");
  check(
    "Invoice / job / payment / communication counts unchanged for Alpha writes",
    (await countBusinessInvoices(prisma, businessA.id)) === invoicesBefore &&
      (await countBusinessJobs(prisma, businessA.id)) === jobsBefore &&
      (await countBusinessPayments(prisma, businessA.id)) === paymentsBefore &&
      (await countBusinessCommunications(prisma, businessA.id)) === commsBefore,
  );
  check(
    "Portal description does not invent a legal conclusion",
    JOB_AFTERCARE_PORTAL_DESCRIPTION.includes("Shown as written") &&
      !/covered|expires|legal advice/i.test(JOB_AFTERCARE_PORTAL_DESCRIPTION),
  );

  console.log("\nUNPUBLISH — already-published text can be withdrawn after leaving COMPLETED");
  const reopenJob = await createJob(businessA.id, { token: `reopen-${suffix}` });
  await saveJobAftercareDraft(prisma, ownerA, {
    jobId: reopenJob.id,
    instructions: "Withdraw this if the job is reopened.",
  });
  await publishJobAftercare(prisma, ownerA, { jobId: reopenJob.id });
  await prisma.job.update({
    where: { id: reopenJob.id },
    data: { status: "IN_PROGRESS" },
  });
  const stillPublished = await loadPublishedAftercareForProjectToken(
    prisma,
    reopenJob.projectToken,
  );
  check(
    "Token still sees published text after the job leaves COMPLETED",
    stillPublished?.instructions === "Withdraw this if the job is reopened.",
  );
  await expectThrow(
    "Draft save still requires COMPLETED after the job is reopened",
    () =>
      saveJobAftercareDraft(prisma, ownerA, {
        jobId: reopenJob.id,
        instructions: "Cannot revise after reopen.",
      }),
    (error) => error.message === JOB_AFTERCARE_COMPLETED_JOB_MESSAGE,
  );
  const withdrawn = await unpublishJobAftercare(prisma, ownerA, {
    jobId: reopenJob.id,
  });
  check(
    "OWNER can unpublish after the job leaves COMPLETED",
    withdrawn.aftercare.status === "UNPUBLISHED" &&
      withdrawn.aftercare.publishedInstructions == null,
  );
  check(
    "Token no longer sees withdrawn text after unpublish on a non-completed job",
    (await loadPublishedAftercareForProjectToken(prisma, reopenJob.projectToken)) ===
      null,
  );

  console.log("\nCONCURRENCY — 8 parallel publishes share the FOR UPDATE job lock");
  const raceJob = await createJob(businessA.id, { token: `race-${suffix}` });
  await saveJobAftercareDraft(prisma, ownerA, {
    jobId: raceJob.id,
    instructions: "One published wording only.",
  });
  const publishBarrier = createWriteBarrier(8, 8000);
  jobAftercareTestHooks.beforeJobLock = async ({ kind }) => {
    if (kind === "publish") await publishBarrier.arriveAndWait();
  };
  const raceClients = Array.from({ length: 8 }, () => session.createClient());
  try {
    const raceResults = await Promise.allSettled(
      raceClients.map((client) =>
        publishJobAftercare(client, ownerA, { jobId: raceJob.id }),
      ),
    );
    const publishedEvents = await prisma.jobAftercareEvent.count({
      where: {
        businessId: businessA.id,
        jobId: raceJob.id,
        eventType: "PUBLISHED",
      },
    });
    const fulfilled = raceResults.filter((result) => result.status === "fulfilled");
    check(
      "Eight parallel publishes produce exactly one PUBLISHED event",
      publishedEvents === 1 && fulfilled.length === 8,
    );
    check(
      "Race result stays PUBLISHED with the same wording",
      (await prisma.jobAftercareInstruction.findFirst({
        where: { jobId: raceJob.id, businessId: businessA.id },
      }))?.status === "PUBLISHED",
    );
  } finally {
    jobAftercareTestHooks.beforeJobLock = undefined;
    await Promise.all(raceClients.map((client) => client.$disconnect()));
  }

  console.log("\nMISSING SCHEMA — loaders degrade; writes fail closed");
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "JobAftercareEvent" CASCADE`);
  await prisma.$executeRawUnsafe(
    `DROP TABLE IF EXISTS "JobAftercareInstruction" CASCADE`,
  );
  const missingTables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('JobAftercareInstruction', 'JobAftercareEvent')
  `;
  check("Aftercare tables are absent after the drop", missingTables.length === 0);

  let tokenMissingError = null;
  let tokenMissing = "threw";
  try {
    tokenMissing = await loadPublishedAftercareForProjectToken(prisma, tokenA);
  } catch (error) {
    tokenMissingError = error;
  }
  let ownerMissingError = null;
  let ownerMissing = "threw";
  try {
    ownerMissing = await loadJobAftercareReview(prisma, ownerA, completedA.id);
  } catch (error) {
    ownerMissingError = error;
  }
  let inProgressMissingError = null;
  let inProgressMissing = "threw";
  try {
    inProgressMissing = await loadJobAftercareReview(prisma, ownerA, inProgressA.id);
  } catch (error) {
    inProgressMissingError = error;
  }
  let foreignMissingError = null;
  let foreignMissing = "threw";
  try {
    foreignMissing = await loadPublishedAftercareForProjectToken(prisma, tokenB);
  } catch (error) {
    foreignMissingError = error;
  }
  check(
    "Token loader returns null without throwing when aftercare tables are missing",
    tokenMissing === null && tokenMissingError === null,
  );
  check(
    "Owner loader returns null without throwing when aftercare tables are missing",
    ownerMissing === null && ownerMissingError === null,
  );
  check(
    "In-progress job owner loader degrades without throwing",
    inProgressMissing === null && inProgressMissingError === null,
  );
  check(
    "Foreign token loader degrades without throwing",
    foreignMissing === null && foreignMissingError === null,
  );
  await expectThrow(
    "Publish fail-closes with a clear setup-pending error when tables are missing",
    () => publishJobAftercare(prisma, ownerA, { jobId: completedA.id }),
    (error) =>
      error.name === "JobAftercareError" &&
      error.message === JOB_AFTERCARE_UNAVAILABLE_MESSAGE,
  );
  const stillMissing = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('JobAftercareInstruction', 'JobAftercareEvent')
  `;
  check(
    "Failed writes do not recreate the dropped aftercare tables",
    stillMissing.length === 0,
  );
} catch (error) {
  console.error(error);
  failed += 1;
} finally {
  if (session) {
    await session.cleanup();
  }
}

console.log(
  failed === 0
    ? `\nAll job-aftercare checks passed (${passed}).`
    : `\n${failed} job-aftercare check(s) failed.`,
);
process.exitCode = failed === 0 ? 0 : 1;

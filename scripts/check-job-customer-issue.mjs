/**
 * Structured customer-reported issue on a completed same-business job.
 *
 * ONE queue: reuses JobCallback. Dedicated local disposable database
 * (name prefix tbbt_job_customer_issue).
 *
 * Proves one complaint through any path creates exactly one queue
 * entry, token/job isolation, duplicate submissions, concurrent
 * OWNER outcomes, private-document attachments, and closed
 * NO_RETURN_VISIT refusal. OWNER outcome and private notes stay off
 * the project token. Does not invent coverage, write a second queue,
 * write a CustomerFollowUp, invoice, schedule, or message the customer.
 *
 * Run with:
 *   npm run test:job-customer-issue
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

register(new URL("./job-customer-issue-test-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for job-customer-issue checks.");
  process.exit(generateEarly.status ?? 1);
}

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const { joinLineDescriptionFromParts, splitLineDescription } = await import(
  "@/lib/estimate-line-scope"
);
const { PROJECT_DOCUMENT_PURPOSE } = await import(
  "@/lib/business-storage/project-documents"
);
const {
  JOB_CALLBACK_ALREADY_OPEN_MESSAGE,
  JOB_CALLBACK_ATTACHMENT_INVALID_MESSAGE,
  JOB_CALLBACK_COMPLETED_JOB_MESSAGE,
  JOB_CALLBACK_COVERAGE_REFUSED_MESSAGE,
  JOB_CALLBACK_JOB_REQUIRED_MESSAGE,
  JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE,
  JOB_CALLBACK_OUTCOME_ALREADY_RECORDED_MESSAGE,
  JOB_CALLBACK_OWNER_ONLY_MESSAGE,
  JOB_CALLBACK_OWNER_WORKFLOW_MESSAGE,
  JOB_CALLBACK_PORTAL_CLOSED_MESSAGE,
  JOB_CALLBACK_PORTAL_RECEIVED_MESSAGE,
  JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE,
  JOB_CALLBACK_PORTAL_WORKFLOW_MESSAGE,
  JOB_CALLBACK_RECORDED_MESSAGE,
  JOB_CALLBACK_UNKNOWN_MESSAGE,
  JOB_CALLBACK_UNAVAILABLE_MESSAGE,
  JOB_CALLBACK_WARRANTY_DISCLAIMER,
  jobCallbackWriteAllowed,
  missingJobCallbackIssueSchema,
} = await import("@/lib/job-callback");
const { loadJobCallbackReview } = await import("@/lib/job-callback-data");
const {
  JOB_CALLBACK_CORE_SELECT,
  jobCallbackErrorMessage,
  jobCallbackTestHooks,
  recordCustomerReportedCallback,
  recordCustomerReportedCallbackOutcome,
  reviewCustomerReportedCallback,
} = await import("@/lib/job-callback-ops");
const { loadPortalJobCallbackView } = await import("@/lib/portal-job-callback-data");
const { submitPortalJobCallback } = await import("@/lib/portal-job-callback-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the job-customer-issue check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "job-customer-issue dedicated local database");

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
      business: { id: businessId, name: "Issue Co" },
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

const schemaSrc = read("prisma/schema.prisma");
const migrationSrc = read(
  "prisma/migrations/20261002180000_job_customer_issue/migration.sql",
);
const opsSrc = read("src/lib/job-callback-ops.ts");
const portalOpsSrc = read("src/lib/portal-job-callback-ops.ts");
const dataSrc = read("src/lib/job-callback-data.ts");
const portalDataSrc = read("src/lib/portal-job-callback-data.ts");
const actionSrc = read("src/app/actions/job-callback.ts");
const portalActionSrc = read("src/app/actions/portal-job-callback.ts");
const formSrc = read("src/components/jobs/job-callback-panel.tsx");
const portalFormSrc = read("src/components/portal/request-job-callback-form.tsx");
const pageSrc = read("src/app/(app)/jobs/[jobId]/page.tsx");
const portalSrc = read("src/app/p/[token]/page.tsx");
const mergeSrc = read("src/lib/customer-merge-ops.ts");
const navSrc = read("src/components/record-nav.tsx");
const featureSrc = [
  opsSrc,
  portalOpsSrc,
  dataSrc,
  portalDataSrc,
  actionSrc,
  portalActionSrc,
  formSrc,
  portalFormSrc,
].join("\n");

console.log("\nSTATIC — one JobCallback queue, customer status vs private findings");
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
      formSrc + actionSrc + pageSrc + portalFormSrc + portalSrc,
    ) &&
    JOB_CALLBACK_WARRANTY_DISCLAIMER.includes("does not determine coverage") &&
    JOB_CALLBACK_OWNER_WORKFLOW_MESSAGE.includes("does not create an invoice") &&
    JOB_CALLBACK_PORTAL_WORKFLOW_MESSAGE.includes("does not promise coverage") &&
    JOB_CALLBACK_RECORDED_MESSAGE.includes("No invoice") &&
    JOB_CALLBACK_PORTAL_CLOSED_MESSAGE.includes("not a warranty"),
);
check(
  "Write path does not invoice, schedule, message, or open a second queue",
  !opsSrc.includes("invoice.create") &&
    !opsSrc.includes("persistDraftInvoice") &&
    !opsSrc.includes("tx.job.create") &&
    !opsSrc.includes("payment.create") &&
    !opsSrc.includes("notifyCustomer") &&
    !opsSrc.includes("sendCustomer") &&
    !opsSrc.includes("customerFollowUp.create") &&
    !opsSrc.includes("jobCustomerIssue.create") &&
    !portalOpsSrc.includes("customerFollowUp.create") &&
    !portalOpsSrc.includes("jobCustomerIssue") &&
    !actionSrc.includes("notifyCustomer") &&
    !portalActionSrc.includes("notifyCustomer") &&
    !formSrc.includes("Create invoice"),
);
check(
  "Does not touch CustomerFollowUp beyond the existing customer-merge remap",
  !opsSrc.includes("customerFollowUp") &&
    !portalOpsSrc.includes("customerFollowUp") &&
    !mergeSrc.includes("JobCustomerIssue") &&
    !mergeSrc.includes("jobCustomerIssue"),
);
check(
  "ONE queue: JobCallback is extended additively; no parallel issue models",
  schemaSrc.includes("model JobCallback") &&
    schemaSrc.includes("model JobCallbackEvent") &&
    schemaSrc.includes("model JobCallbackAttachment") &&
    schemaSrc.includes("ownerNotes") &&
    /category\s+String\?/.test(schemaSrc) &&
    !schemaSrc.includes("model JobCustomerIssue") &&
    !schemaSrc.includes("model JobCustomerIssueEvent") &&
    !schemaSrc.includes("model JobCustomerIssueAttachment") &&
    schemaSrc.includes("Application code must never update or delete an existing row") &&
    migrationSrc.includes('ALTER TABLE "JobCallback"') &&
    migrationSrc.includes('ADD COLUMN IF NOT EXISTS "category"') &&
    migrationSrc.includes('ADD COLUMN IF NOT EXISTS "ownerNotes"') &&
    migrationSrc.includes('CREATE TABLE IF NOT EXISTS "JobCallbackAttachment"') &&
    migrationSrc.includes("20261002180000") &&
    !migrationSrc.includes('CREATE TABLE IF NOT EXISTS "JobCustomerIssue"') &&
    !migrationSrc.includes('ALTER TABLE "Job"') &&
    !migrationSrc.includes('ALTER TABLE "CustomerFollowUp"') &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSrc) &&
    opsSrc.includes("jobCallbackEvent.create") &&
    !opsSrc.includes("jobCallbackEvent.update") &&
    !opsSrc.includes("jobCallbackEvent.delete"),
);
check(
  "Existing open-callback partial unique index remains the one-open-case guard",
  read("prisma/migrations/20260929010900_job_callback/migration.sql").includes(
    "JobCallback_open_job_key",
  ) && !migrationSrc.includes("JobCustomerIssue_one_open_per_job"),
);
check(
  "Owner loader is mutation-free; token loader is customer-visible only",
  dataSrc.includes("...access.scope") &&
    dataSrc.includes("loadRecordedWarrantyTerms") &&
    dataSrc.includes("ownerNotes") &&
    portalDataSrc.includes("findLiveJobByProjectToken") &&
    portalDataSrc.includes("customerVisibleStatus") &&
    !portalDataSrc.includes("ownerNotes") &&
    !portalDataSrc.includes("storageKey") &&
    !portalDataSrc.includes("recordedByMembershipId") &&
    !portalDataSrc.includes("outcomeByMembershipId") &&
    !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(
      dataSrc + portalDataSrc,
    ),
);
check(
  "Loaders degrade on missing issue columns/attachment table (P2021/P2022)",
  missingJobCallbackIssueSchema({ code: "P2021" }) &&
    missingJobCallbackIssueSchema({ code: "P2022" }) &&
    !missingJobCallbackIssueSchema({ code: "P2002" }) &&
    !missingJobCallbackIssueSchema(new Error("Can't reach database server")) &&
    dataSrc.includes("if (missingJobCallbackIssueSchema(error)) return empty") &&
    portalDataSrc.includes("if (missingJobCallbackIssueSchema(error))") &&
    jobCallbackErrorMessage({ code: "P2021" }, "fallback") ===
      JOB_CALLBACK_UNAVAILABLE_MESSAGE,
);
check(
  "No-extras writes never touch new columns; extras map P2021/P2022 only when used",
  opsSrc.includes("select: JOB_CALLBACK_CORE_SELECT") &&
    portalOpsSrc.includes("select: JOB_CALLBACK_CORE_SELECT") &&
    opsSrc.includes("usedIssueExtensions") &&
    portalOpsSrc.includes("usedIssueExtensions") &&
    opsSrc.includes("usedIssueExtensions && missingJobCallbackIssueSchema(error)") &&
    portalOpsSrc.includes("usedIssueExtensions && missingJobCallbackIssueSchema(error)") &&
    !/if \(missingJobCallbackIssueSchema\(error\)\) return;/.test(opsSrc) &&
    !/if \(!missingJobCallbackIssueSchema\(error\)\) throw error;/.test(portalOpsSrc),
);
check(
  "Customers have exactly one portal form; Work Order keeps one OWNER panel",
  pageSrc.includes("JobCallbackPanel") &&
    !pageSrc.includes("JobCustomerIssuePanel") &&
    !pageSrc.includes("Customer-reported issue") &&
    formSrc.includes("Recorded warranty terms") &&
    formSrc.includes("Private owner notes") &&
    portalSrc.includes("loadPortalJobCallbackView") &&
    portalSrc.includes("RequestJobCallbackForm") &&
    !portalSrc.includes("loadPortalJobCustomerIssueView") &&
    !portalSrc.includes("ReportJobIssueForm") &&
    !portalSrc.includes("ProjectReportedIssue") &&
    !portalSrc.includes("reported-issue") &&
    portalFormSrc.includes("JOB_CALLBACK_PORTAL_WORKFLOW_MESSAGE") &&
    !portalFormSrc.includes("ownerNotes") &&
    !navSrc.includes("customer-issue") &&
    !navSrc.includes("Customer issue"),
);
check(
  "loadOwnedCallback scopes by businessId so foreign and missing ids look the same",
  opsSrc.includes("where: { id: callbackId, ...access.scope }") &&
    opsSrc.includes("JOB_CALLBACK_UNKNOWN_MESSAGE") &&
    opsSrc.includes("if (!row)") &&
    opsSrc.includes("throw new JobCallbackError(JOB_CALLBACK_UNKNOWN_MESSAGE)"),
);
check(
  "Portal HTML does not embed raw markup from customer text",
  portalSrc.includes("{callbackView.description}") &&
    !portalSrc.includes("dangerouslySetInnerHTML") &&
    !portalFormSrc.includes("dangerouslySetInnerHTML"),
);
check(
  "Closed NO_RETURN_VISIT is a refused portal re-file, not a new case",
  portalOpsSrc.includes("isPortalJobCallbackClosed") &&
    portalOpsSrc.includes("JOB_CALLBACK_PORTAL_CLOSED_MESSAGE") &&
    portalDataSrc.includes('status: "closed"') &&
    portalSrc.includes("JOB_CALLBACK_PORTAL_CLOSED_MESSAGE") &&
    JOB_CALLBACK_PORTAL_CLOSED_MESSAGE.includes("cannot send another request"),
);

let session;
try {
  session = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_job_customer_issue",
    setProcessEnv: true,
  });
  const prisma = session.prisma;
  check(
    "Dedicated local disposable database opened",
    Boolean(session.testDbName?.startsWith("tbbt_job_customer_issue_")),
  );

  const suffix = randomUUID().slice(0, 8);
  const ownerUser = await prisma.user.create({
    data: { name: "Owen", email: `owner-ci-${suffix}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ada", email: `admin-ci-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mel", email: `member-ci-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-ci-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerCUser = await prisma.user.create({
    data: { name: "Cam", email: `gamma-ci-${suffix}@example.com`, passwordHash: "x" },
  });

  const businessA = await prisma.business.create({
    data: { name: "Alpha Issues", slug: `alpha-ci-${suffix}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Issues", slug: `beta-ci-${suffix}`, tradeCode: "CLEANING" },
  });
  const businessC = await prisma.business.create({
    data: { name: "Gamma Issues", slug: `gamma-ci-${suffix}`, tradeCode: "HANDYMAN" },
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
        name: "Issue Customer",
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

  async function createPrivateDocument(input) {
    const storage =
      (await prisma.businessStorageAccount.findUnique({
        where: { businessId: input.businessId },
      })) ??
      (await prisma.businessStorageAccount.create({
        data: {
          businessId: input.businessId,
          provider: "R2",
          mode: "MANAGED",
          bucketName: `tbbt-ci-${input.businessId.slice(0, 8)}`,
          namespacePrefix: `businesses/${input.businessId}`,
          storageLimitBytes: BigInt(1024 * 1024),
        },
      }));
    return prisma.storedAsset.create({
      data: {
        businessId: input.businessId,
        storageAccountId: storage.id,
        jobId: input.jobId,
        category: input.category ?? "DOCUMENT",
        purpose: input.purpose ?? PROJECT_DOCUMENT_PURPOSE,
        originalFilename: input.originalFilename,
        storageKey: input.storageKey ?? `ci-${randomUUID()}`,
        mimeType: "application/pdf",
        fileSizeBytes: 2048,
        visibility: input.visibility ?? "PRIVATE",
        status: input.status ?? "READY",
        publicPath: input.publicPath ?? null,
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

  const privateDocA = await createPrivateDocument({
    businessId: businessA.id,
    jobId: completedA.id,
    originalFilename: "job-a-photo.pdf",
    storageKey: `secret-a-${suffix}`,
  });
  const sisterDocA = await createPrivateDocument({
    businessId: businessA.id,
    jobId: completedA2.id,
    originalFilename: "sister-job.pdf",
    storageKey: `secret-a2-${suffix}`,
  });
  const publicDocA = await createPrivateDocument({
    businessId: businessA.id,
    jobId: completedA.id,
    originalFilename: "public-should-not-attach.pdf",
    storageKey: `public-a-${suffix}`,
    visibility: "PUBLIC",
    publicPath: "/public/nope.pdf",
  });
  const privateDocB = await createPrivateDocument({
    businessId: businessB.id,
    jobId: completedB.id,
    originalFilename: "beta-only.pdf",
    storageKey: `secret-b-${suffix}`,
  });

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

  const invoicesBefore = await prisma.invoice.count({ where: { businessId: businessA.id } });
  const jobsBefore = await prisma.job.count({ where: { businessId: businessA.id } });
  const paymentsBefore = await prisma.payment.count({ where: { businessId: businessA.id } });
  const commsBefore = await prisma.customerCommunication.count({
    where: { businessId: businessA.id },
  });
  const followUpsBefore = await prisma.customerFollowUp.count({
    where: { businessId: businessA.id },
  });

  console.log("\nAUTH — ADMIN and MEMBER cannot write");
  await expectThrow(
    "ADMIN cannot record a callback",
    () =>
      recordCustomerReportedCallback(prisma, adminA, {
        jobId: completedA.id,
        description: "Paint peel",
        reportedVia: "PHONE",
        category: "QUALITY_CONCERN",
      }),
    (error) =>
      error instanceof ForbiddenError &&
      jobCallbackErrorMessage(error, "") === JOB_CALLBACK_OWNER_ONLY_MESSAGE,
  );
  await expectThrow(
    "MEMBER cannot record an outcome",
    () =>
      recordCustomerReportedCallbackOutcome(prisma, memberA, {
        callbackId: "missing",
        outcome: "RECORDED_ONLY",
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
      error.name === "JobCallbackError" &&
      error.message === JOB_CALLBACK_JOB_REQUIRED_MESSAGE,
  );
  const inProgressPortal = await submitPortalJobCallback(prisma, {
    token: inProgressA.projectToken,
    description: "Portal too early",
    preferredContact: "PHONE",
    category: "QUALITY_CONCERN",
  });
  check(
    "Portal hides or refuses an in-progress job",
    inProgressPortal.ok === false &&
      (inProgressPortal.error === JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE ||
        inProgressPortal.error.includes("complete")),
  );

  console.log("\nONE QUEUE — one complaint through any path is one JobCallback");
  const firstPortal = await submitPortalJobCallback(prisma, {
    token: tokenA,
    description: "The latch sticks after the visit.",
    preferredContact: "TEXT",
    category: "QUALITY_CONCERN",
    storedAssetIds: [privateDocA.id],
  });
  check(
    "Portal records a JobCallback for the token-scoped job",
    firstPortal.ok === true &&
      firstPortal.alreadyExists === false &&
      firstPortal.jobId === completedA.id,
  );
  await expectThrow(
    "OWNER record of the same complaint is refused as already open",
    () =>
      recordCustomerReportedCallback(prisma, ownerA, {
        jobId: completedA.id,
        description: "Same latch, second form.",
        reportedVia: "PHONE",
        category: "DAMAGE",
      }),
    (error) => error.message === JOB_CALLBACK_ALREADY_OPEN_MESSAGE,
  );
  const duplicatePortal = await submitPortalJobCallback(prisma, {
    token: tokenA,
    description: "A second tap should not open another case.",
    preferredContact: "EMAIL",
    category: "DAMAGE",
  });
  check(
    "Duplicate portal submit is idempotent on the open JobCallback",
    duplicatePortal.ok === true &&
      duplicatePortal.alreadyExists === true &&
      duplicatePortal.callbackId === firstPortal.callbackId,
  );
  const ownerPathJob = await createJob(businessA.id, { token: `owner-path-${suffix}` });
  const ownerFirst = await recordCustomerReportedCallback(prisma, ownerA, {
    jobId: ownerPathJob.id,
    description: "Owner-recorded concern about the latch.",
    reportedVia: "PHONE",
    category: "QUALITY_CONCERN",
  });
  const portalAfterOwner = await submitPortalJobCallback(prisma, {
    token: ownerPathJob.projectToken,
    description: "Customer tapping the same concern.",
    preferredContact: "PHONE",
    category: "DAMAGE",
  });
  check(
    "Portal submit after OWNER record reuses the same open JobCallback",
    portalAfterOwner.ok === true &&
      portalAfterOwner.alreadyExists === true &&
      portalAfterOwner.callbackId === ownerFirst.id,
  );
  const queueRowsA = await prisma.jobCallback.findMany({
    where: { jobId: completedA.id, businessId: businessA.id },
  });
  const queueRowsOwnerPath = await prisma.jobCallback.findMany({
    where: { jobId: ownerPathJob.id, businessId: businessA.id },
  });
  check(
    "One complaint through any path => exactly one queue entry",
    queueRowsA.length === 1 &&
      queueRowsOwnerPath.length === 1 &&
      queueRowsA[0].id === firstPortal.callbackId &&
      queueRowsOwnerPath[0].id === ownerFirst.id,
  );
  const issueTables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('JobCustomerIssue', 'JobCustomerIssueEvent', 'JobCustomerIssueAttachment')
  `;
  check("No parallel JobCustomerIssue queue tables exist", issueTables.length === 0);

  console.log("\nPORTAL SUBMIT — token/job isolation");
  const foreignTokenSubmit = await submitPortalJobCallback(prisma, {
    token: tokenB,
    description: "Trying to attach Alpha's job",
    preferredContact: "PHONE",
    storedAssetIds: [privateDocA.id],
  });
  check("Foreign token cannot attach Alpha's document to Beta", foreignTokenSubmit.ok === false);
  const sisterTokenSubmit = await submitPortalJobCallback(prisma, {
    token: tokenA2,
    description: "Sister token should not land on job A",
    preferredContact: "PHONE",
    storedAssetIds: [privateDocA.id],
  });
  check("Same-business sister token cannot attach job A's document", sisterTokenSubmit.ok === false);
  const betaRows = await prisma.jobCallback.findMany({
    where: { jobId: completedB.id, businessId: businessB.id },
  });
  check("Failed foreign/sister submits did not create a Beta JobCallback", betaRows.length === 0);

  const portalView = await loadPortalJobCallbackView(prisma, tokenA);
  const portalViewJson = JSON.stringify(portalView);
  check(
    "Token view is already_requested and omits private findings and storage keys",
    portalView.status === "already_requested" &&
      portalView.jobId === completedA.id &&
      portalView.customerVisibleStatus === "received" &&
      portalView.attachments[0]?.originalFilename === "job-a-photo.pdf" &&
      !portalViewJson.includes("ownerNotes") &&
      !portalViewJson.includes("WILL_FOLLOW_UP") &&
      !portalViewJson.includes("outcome") &&
      !portalViewJson.includes(privateDocA.storageKey) &&
      !portalViewJson.includes("secret-a") &&
      !portalViewJson.includes(memOwnerA.id),
  );
  const sisterView = await loadPortalJobCallbackView(prisma, tokenA2);
  check(
    "Sister token cannot read job A's callback",
    sisterView.status === "ready" && sisterView.jobId === completedA2.id,
  );
  const betaView = await loadPortalJobCallbackView(prisma, tokenB);
  check(
    "Foreign token cannot read Alpha's callback",
    betaView.status === "ready" &&
      betaView.jobId === completedB.id &&
      !JSON.stringify(betaView).includes("latch sticks"),
  );
  check(
    "Unknown token is hidden",
    (await loadPortalJobCallbackView(prisma, "missing-token")).status === "hidden",
  );

  console.log("\nOWNER REVIEW — private notes stay off the token");
  const ownerReview = await loadJobCallbackReview(prisma, ownerA, completedA.id);
  check(
    "OWNER review includes the portal report and attachable private documents",
    ownerReview?.callbacks[0]?.id === firstPortal.callbackId &&
      ownerReview?.callbacks[0]?.description.includes("latch sticks") &&
      ownerReview?.callbacks[0]?.attachments[0]?.originalFilename === "job-a-photo.pdf" &&
      ownerReview?.attachableDocuments.some((doc) => doc.id === privateDocA.id) === true,
  );
  const reviewed = await reviewCustomerReportedCallback(prisma, ownerA, {
    callbackId: firstPortal.callbackId,
    ownerNotes: "SECRET owner finding: hinge was already worn.",
  });
  check(
    "Review moves status to UNDER_REVIEW and stores private notes",
    reviewed.callback.status === "UNDER_REVIEW",
  );
  const reviewedRow = await prisma.jobCallback.findFirst({
    where: { id: firstPortal.callbackId, businessId: businessA.id },
  });
  check(
    "Private owner notes are stored on the JobCallback row",
    reviewedRow?.ownerNotes.includes("SECRET owner finding") === true,
  );
  const tokenAfterReview = await loadPortalJobCallbackView(prisma, tokenA);
  const tokenAfterReviewJson = JSON.stringify(tokenAfterReview);
  check(
    "Token sees In review without owner notes or an outcome",
    tokenAfterReview.status === "already_requested" &&
      tokenAfterReview.customerVisibleStatus === "in_review" &&
      tokenAfterReview.customerVisibleStatusLabel === "In review" &&
      !tokenAfterReviewJson.includes("SECRET owner finding") &&
      !tokenAfterReviewJson.includes("WILL_FOLLOW_UP") &&
      !tokenAfterReviewJson.includes("hinge was already worn"),
  );
  const foreignOwnerReview = await loadJobCallbackReview(prisma, ownerA, completedB.id);
  check("Foreign job owner review is null", foreignOwnerReview === null);
  await expectThrow(
    "Alpha cannot decide a missing Beta callback",
    () =>
      recordCustomerReportedCallbackOutcome(prisma, ownerA, {
        callbackId: firstPortal.callbackId + "-nope",
        outcome: "RECORDED_ONLY",
      }),
    (error) => error.message === JOB_CALLBACK_UNKNOWN_MESSAGE,
  );
  const betaCallback = await recordCustomerReportedCallback(prisma, ownerB, {
    jobId: completedB.id,
    description: "Beta customer called about the latch.",
    reportedVia: "PHONE",
  });
  await expectThrow(
    "Alpha cannot review a real Beta callback",
    () => reviewCustomerReportedCallback(prisma, ownerA, { callbackId: betaCallback.id }),
    (error) => error.message === JOB_CALLBACK_UNKNOWN_MESSAGE,
  );
  await expectThrow(
    "Alpha cannot record an outcome on a real Beta callback",
    () =>
      recordCustomerReportedCallbackOutcome(prisma, ownerA, {
        callbackId: betaCallback.id,
        outcome: "RECORDED_ONLY",
      }),
    (error) => error.message === JOB_CALLBACK_UNKNOWN_MESSAGE,
  );
  check(
    "Foreign and nonexistent callback ids refuse with the same not-found message",
    JOB_CALLBACK_UNKNOWN_MESSAGE === "That callback could not be found.",
  );

  console.log("\nATTACHMENTS — existing private storage only");
  await expectThrow(
    "Sister-job private document cannot attach to this job",
    () =>
      recordCustomerReportedCallback(prisma, ownerA, {
        jobId: completedA2.id,
        description: "Wrong document",
        reportedVia: "EMAIL",
        storedAssetIds: [privateDocA.id],
      }),
    (error) => error.message === JOB_CALLBACK_ATTACHMENT_INVALID_MESSAGE,
  );
  await expectThrow(
    "Public document cannot attach",
    () =>
      recordCustomerReportedCallback(prisma, ownerA, {
        jobId: completedA2.id,
        description: "Public file",
        reportedVia: "EMAIL",
        storedAssetIds: [publicDocA.id],
      }),
    (error) => error.message === JOB_CALLBACK_ATTACHMENT_INVALID_MESSAGE,
  );
  await expectThrow(
    "Foreign-business document cannot attach",
    () =>
      recordCustomerReportedCallback(prisma, ownerA, {
        jobId: completedA2.id,
        description: "Beta file",
        reportedVia: "EMAIL",
        storedAssetIds: [privateDocB.id],
      }),
    (error) => error.message === JOB_CALLBACK_ATTACHMENT_INVALID_MESSAGE,
  );
  const attachedSister = await recordCustomerReportedCallback(prisma, ownerA, {
    jobId: completedA2.id,
    description: "Sister job with its own private document.",
    reportedVia: "PHONE",
    storedAssetIds: [sisterDocA.id],
    category: "INCOMPLETE_WORK",
  });
  check("Same-job private document attaches", attachedSister.jobId === completedA2.id);
  const sisterOwner = await loadJobCallbackReview(prisma, ownerA, completedA2.id);
  check(
    "Attached filename is recorded without leaking the storage key",
    sisterOwner?.callbacks[0]?.attachments[0]?.originalFilename === "sister-job.pdf" &&
      !JSON.stringify(sisterOwner?.callbacks[0]?.attachments ?? []).includes(
        sisterDocA.storageKey,
      ),
  );

  console.log("\nCONCURRENCY — parallel outcomes share the FOR UPDATE job lock");
  const raceJob = await createJob(businessA.id, { token: `race-${suffix}` });
  const raceCallback = await recordCustomerReportedCallback(prisma, ownerA, {
    jobId: raceJob.id,
    description: "One outcome only.",
    reportedVia: "PHONE",
  });
  await reviewCustomerReportedCallback(prisma, ownerA, { callbackId: raceCallback.id });
  const decideBarrier = createWriteBarrier(2, 8000);
  jobCallbackTestHooks.beforeJobLock = async ({ kind }) => {
    if (kind === "outcome") await decideBarrier.arriveAndWait();
  };
  const raceA = session.createClient();
  const raceB = session.createClient();
  try {
    const raceResults = await Promise.allSettled([
      recordCustomerReportedCallbackOutcome(raceA, ownerA, {
        callbackId: raceCallback.id,
        outcome: "WILL_FOLLOW_UP",
        ownerNotes: "First writer",
      }),
      recordCustomerReportedCallbackOutcome(raceB, ownerA, {
        callbackId: raceCallback.id,
        outcome: "RECORDED_ONLY",
        ownerNotes: "Second writer",
      }),
    ]);
    const outcomeEvents = await prisma.jobCallbackEvent.count({
      where: {
        businessId: businessA.id,
        callbackId: raceCallback.id,
        eventType: "OUTCOME_RECORDED",
      },
    });
    const closed = await prisma.jobCallback.findFirst({
      where: { id: raceCallback.id, businessId: businessA.id },
    });
    const fulfilled = raceResults.filter((result) => result.status === "fulfilled");
    const rejected = raceResults.filter((result) => result.status === "rejected");
    check(
      "Two parallel outcomes produce exactly one OUTCOME_RECORDED event",
      outcomeEvents === 1 &&
        closed?.status === "OUTCOME_RECORDED" &&
        Boolean(closed?.outcome) &&
        fulfilled.length + rejected.length === 2 &&
        fulfilled.length >= 1,
    );
    check(
      "Losing writer does not overwrite the recorded outcome",
      closed?.outcome === "WILL_FOLLOW_UP" || closed?.outcome === "RECORDED_ONLY",
    );
  } finally {
    jobCallbackTestHooks.beforeJobLock = undefined;
    await Promise.all([raceA.$disconnect(), raceB.$disconnect()]);
  }

  console.log("\nCLOSED CASE — NO_RETURN_VISIT refuses a new portal case");
  const decided = await recordCustomerReportedCallbackOutcome(prisma, ownerA, {
    callbackId: firstPortal.callbackId,
    outcome: "NO_RETURN_VISIT",
    ownerNotes: "SECRET owner finding: hinge was already worn. No return visit.",
  });
  check(
    "Outcome closes the customer-visible status",
    decided.callback.status === "OUTCOME_RECORDED" &&
      decided.callback.outcome === "NO_RETURN_VISIT",
  );
  await expectThrow(
    "Coverage outcomes are refused",
    () =>
      recordCustomerReportedCallbackOutcome(prisma, ownerA, {
        callbackId: firstPortal.callbackId,
        outcome: "COVERED",
      }),
    (error) => error.message === JOB_CALLBACK_COVERAGE_REFUSED_MESSAGE,
  );
  await expectThrow(
    "A different outcome on a closed callback is refused",
    () =>
      recordCustomerReportedCallbackOutcome(prisma, ownerA, {
        callbackId: firstPortal.callbackId,
        outcome: "WILL_FOLLOW_UP",
        ownerNotes: "changed my mind",
      }),
    (error) => error.message === JOB_CALLBACK_OUTCOME_ALREADY_RECORDED_MESSAGE,
  );
  const closedToken = await loadPortalJobCallbackView(prisma, tokenA);
  const closedTokenJson = JSON.stringify(closedToken);
  check(
    "Closed token view shows closed without private findings",
    closedToken.status === "closed" &&
      closedToken.jobId === completedA.id &&
      !closedTokenJson.includes("WILL_FOLLOW_UP") &&
      !closedTokenJson.includes("NO_RETURN_VISIT") &&
      !closedTokenJson.includes("SECRET owner finding") &&
      !closedTokenJson.includes("hinge was already worn") &&
      !closedTokenJson.includes(privateDocA.storageKey),
  );
  const ownerClosed = await loadJobCallbackReview(prisma, ownerA, completedA.id);
  check(
    "OWNER still sees the private outcome and notes after close",
    ownerClosed?.callbacks[0]?.outcome === "NO_RETURN_VISIT" &&
      ownerClosed?.callbacks[0]?.ownerNotes.includes("SECRET owner finding") &&
      ownerClosed?.callbacks[0]?.customerVisibleStatus === "closed",
  );
  let refused = 0;
  let opened = 0;
  for (let i = 0; i < 5; i += 1) {
    const refill = await submitPortalJobCallback(prisma, {
      token: tokenA,
      description: `Later report after close ${i + 1}.`,
      preferredContact: "PHONE",
      category: "OTHER",
    });
    if (!refill.ok && refill.error === JOB_CALLBACK_PORTAL_CLOSED_MESSAGE) {
      refused += 1;
    }
    if (refill.ok && refill.alreadyExists === false) opened += 1;
  }
  const afterClosed = await prisma.jobCallback.count({
    where: { jobId: completedA.id, businessId: businessA.id },
  });
  check(
    "Five portal submits after NO_RETURN_VISIT are refused and do not open a new case",
    refused === 5 && opened === 0 && afterClosed === 1,
  );

  console.log("\nWARRANTY — display recorded terms only");
  const review = await loadJobCallbackReview(prisma, ownerA, completedA.id);
  const titles = (review?.warrantyTerms ?? []).map((term) => term.title);
  check(
    "Recorded vault warranty terms appear as stored",
    titles.includes("Ninety-day workmanship note") &&
      review?.warrantyDisclaimer === JOB_CALLBACK_WARRANTY_DISCLAIMER,
  );
  check(
    "Insurance and foreign warranty are not invented as coverage",
    !titles.includes("General liability") &&
      !titles.includes("Beta-only warranty binder") &&
      !review?.warrantyTerms.some((term) =>
        /invented|automatically covered|still in effect|expired/i.test(term.body ?? ""),
      ),
  );
  const emptyJob = await createJob(businessC.id);
  const emptyReview = await loadJobCallbackReview(prisma, ownerC, emptyJob.id);
  check(
    "Business without recorded warranty terms says none are recorded",
    emptyReview?.warrantyTerms.length === 0 &&
      emptyReview?.noWarrantyTermsMessage === JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE,
  );

  console.log("\nSIDE EFFECTS — no invoice, follow-up, or customer message");
  check(
    "Invoice / payment / communication / follow-up counts unchanged",
    (await prisma.invoice.count({ where: { businessId: businessA.id } })) === invoicesBefore &&
      (await prisma.job.count({ where: { businessId: businessA.id } })) === jobsBefore + 2 &&
      (await prisma.payment.count({ where: { businessId: businessA.id } })) === paymentsBefore &&
      (await prisma.customerCommunication.count({ where: { businessId: businessA.id } })) ===
        commsBefore &&
      (await prisma.customerFollowUp.count({ where: { businessId: businessA.id } })) ===
        followUpsBefore,
  );

  console.log("\nMISSING SCHEMA — attachment table degrade; writes fail closed on missing columns");
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "JobCallbackAttachment" CASCADE`);
  const missingAttachment = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'JobCallbackAttachment'
  `;
  check("JobCallbackAttachment is absent after the drop", missingAttachment.length === 0);

  let tokenMissingError = null;
  let tokenMissing = "threw";
  try {
    tokenMissing = await loadPortalJobCallbackView(prisma, tokenA);
  } catch (error) {
    tokenMissingError = error;
  }
  let ownerMissingError = null;
  let ownerMissing = "threw";
  try {
    ownerMissing = await loadJobCallbackReview(prisma, ownerA, completedA.id);
  } catch (error) {
    ownerMissingError = error;
  }
  check(
    "Token loader still returns closed without throwing when attachments are missing",
    tokenMissing?.status === "closed" && tokenMissingError === null,
  );
  check(
    "Owner loader still returns the callback without throwing when attachments are missing",
    ownerMissing?.callbacks?.[0]?.id === firstPortal.callbackId && ownerMissingError === null,
  );
} catch (error) {
  console.error(error);
  failed += 1;
} finally {
  if (session) {
    await session.cleanup();
  }
}

console.log("\nPREVIEW SAFETY — writes without 20261002180000 still work");
let previewSession;
try {
  previewSession = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_job_callback_preview",
    setProcessEnv: true,
  });
  const preview = previewSession.prisma;
  await preview.$executeRawUnsafe(`ALTER TABLE "JobCallback" DROP COLUMN IF EXISTS "category"`);
  await preview.$executeRawUnsafe(`ALTER TABLE "JobCallback" DROP COLUMN IF EXISTS "ownerNotes"`);
  await preview.$executeRawUnsafe(`DROP TABLE IF EXISTS "JobCallbackAttachment"`);
  const leftover = await preview.$queryRaw`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'JobCallback'
      AND column_name IN ('category', 'ownerNotes')
  `;
  check(
    "Preview schema has JobCallback without the reserved migration columns",
    leftover.length === 0,
  );

  const previewSuffix = randomUUID().slice(0, 8);
  async function seedPreviewJob(token) {
    const ownerUser = await preview.user.create({
      data: {
        name: "Preview Owen",
        email: `preview-owner-${randomUUID().slice(0, 8)}@example.com`,
        passwordHash: "x",
      },
    });
    const business = await preview.business.create({
      data: {
        name: "Preview Co",
        slug: `preview-cb-${randomUUID().slice(0, 8)}`,
        tradeCode: "HANDYMAN",
      },
    });
    const membership = await preview.membership.create({
      data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
    });
    const customer = await preview.customer.create({
      data: {
        businessId: business.id,
        name: "Preview Customer",
        email: `preview-cust-${randomUUID().slice(0, 6)}@example.com`,
      },
    });
    const request = await preview.serviceRequest.create({
      data: { businessId: business.id, customerId: customer.id, description: "Done" },
    });
    const estimate = await preview.estimate.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        serviceRequestId: request.id,
        status: "APPROVED",
        publicToken: randomUUID(),
        total: 100,
      },
    });
    const job = await preview.job.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        estimateId: estimate.id,
        status: "COMPLETED",
        projectToken: token,
      },
    });
    return {
      job,
      access: makeAccess(business.id, "OWNER", membership.id, ownerUser.id),
    };
  }

  const noExtras = await seedPreviewJob(`preview-none-${previewSuffix}`);
  const portalJob = await seedPreviewJob(`preview-portal-${previewSuffix}`);
  const extrasJob = await seedPreviewJob(`preview-extras-${previewSuffix}`);
  const extrasReviewJob = await seedPreviewJob(`preview-review-${previewSuffix}`);

  const recorded = await recordCustomerReportedCallback(preview, noExtras.access, {
    jobId: noExtras.job.id,
    description: "Owner recorded without extras.",
    reportedVia: "PHONE",
  });
  check(
    "OWNER record without extras succeeds when the issue migration is absent",
    recorded.status === "RECORDED" && recorded.jobId === noExtras.job.id,
  );
  const reviewed = await reviewCustomerReportedCallback(preview, noExtras.access, {
    callbackId: recorded.id,
  });
  const reviewEvents = await preview.jobCallbackEvent.count({
    where: { callbackId: recorded.id, eventType: "REVIEWED" },
  });
  check(
    "OWNER review without extras writes a REVIEWED event on the preview schema",
    reviewed.callback.status === "UNDER_REVIEW" && reviewEvents === 1,
  );
  const outcomed = await recordCustomerReportedCallbackOutcome(preview, noExtras.access, {
    callbackId: recorded.id,
    outcome: "RECORDED_ONLY",
  });
  const outcomeEvents = await preview.jobCallbackEvent.count({
    where: { callbackId: recorded.id, eventType: "OUTCOME_RECORDED" },
  });
  check(
    "OWNER outcome without extras writes an OUTCOME_RECORDED event on the preview schema",
    outcomed.callback.status === "OUTCOME_RECORDED" &&
      outcomed.callback.outcome === "RECORDED_ONLY" &&
      outcomeEvents === 1,
  );

  const portalNone = await submitPortalJobCallback(preview, {
    token: portalJob.job.projectToken,
    description: "Portal submit without extras.",
    preferredContact: "PHONE",
  });
  check(
    "Portal submit without extras succeeds when the issue migration is absent",
    portalNone.ok === true && portalNone.alreadyExists === false,
  );

  await expectThrow(
    "OWNER record with extras is unavailable on the preview schema",
    () =>
      recordCustomerReportedCallback(preview, extrasJob.access, {
        jobId: extrasJob.job.id,
        description: "Should not land.",
        reportedVia: "PHONE",
        category: "QUALITY_CONCERN",
      }),
    (error) =>
      error.name === "JobCallbackError" &&
      error.message === JOB_CALLBACK_UNAVAILABLE_MESSAGE,
  );
  const extrasPortal = await submitPortalJobCallback(preview, {
    token: extrasJob.job.projectToken,
    description: "Portal extras should fail closed.",
    preferredContact: "EMAIL",
    category: "DAMAGE",
  });
  check(
    "Portal submit with extras returns a clean unavailable message",
    extrasPortal.ok === false && extrasPortal.error === JOB_CALLBACK_UNAVAILABLE_MESSAGE,
  );
  const extrasRows = await preview.jobCallback.count({
    where: { jobId: extrasJob.job.id },
  });
  check(
    "Failed extras writes do not leave a queue row on the preview schema",
    extrasRows === 0,
  );

  const previewOpen = await recordCustomerReportedCallback(preview, extrasReviewJob.access, {
    jobId: extrasReviewJob.job.id,
    description: "No-extras record so review/outcome extras can be tried.",
    reportedVia: "TEXT",
  });
  await expectThrow(
    "OWNER review with extras is unavailable on the preview schema",
    () =>
      reviewCustomerReportedCallback(preview, extrasReviewJob.access, {
        callbackId: previewOpen.id,
        ownerNotes: "Should not persist.",
      }),
    (error) => error.message === JOB_CALLBACK_UNAVAILABLE_MESSAGE,
  );
  const reviewStillRecorded = await preview.jobCallback.findFirst({
    where: { id: previewOpen.id },
    select: JOB_CALLBACK_CORE_SELECT,
  });
  const reviewEventAfterFail = await preview.jobCallbackEvent.count({
    where: { callbackId: previewOpen.id, eventType: "REVIEWED" },
  });
  check(
    "Failed extras review does not abort into 25P02 or write a REVIEWED event",
    reviewStillRecorded?.status === "RECORDED" && reviewEventAfterFail === 0,
  );
  const reviewedClean = await reviewCustomerReportedCallback(preview, extrasReviewJob.access, {
    callbackId: previewOpen.id,
  });
  await expectThrow(
    "OWNER outcome with extras is unavailable on the preview schema",
    () =>
      recordCustomerReportedCallbackOutcome(preview, extrasReviewJob.access, {
        callbackId: previewOpen.id,
        outcome: "RECORDED_ONLY",
        ownerNotes: "Should not persist.",
      }),
    (error) => error.message === JOB_CALLBACK_UNAVAILABLE_MESSAGE,
  );
  const outcomeEventAfterFail = await preview.jobCallbackEvent.count({
    where: { callbackId: previewOpen.id, eventType: "OUTCOME_RECORDED" },
  });
  check(
    "Failed extras outcome leaves the callback under review with no outcome event",
    reviewedClean.callback.status === "UNDER_REVIEW" && outcomeEventAfterFail === 0,
  );
} catch (error) {
  console.error(error);
  failed += 1;
} finally {
  if (previewSession) {
    await previewSession.cleanup();
  }
}

console.log(
  failed === 0
    ? `\nAll job-customer-issue checks passed (${passed}).`
    : `\n${failed} job-customer-issue check(s) failed.`,
);
process.exitCode = failed === 0 ? 0 : 1;

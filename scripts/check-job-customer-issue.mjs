/**
 * Structured customer-reported issue on a completed same-business job.
 *
 * Dedicated local disposable database (name prefix tbbt_job_customer_issue).
 *
 * Proves token/job isolation, duplicate submissions, concurrent
 * decisions, private-document attachments, and closed-case behavior.
 * OWNER decision and private notes stay off the project token.
 * Does not invent coverage, write a JobCallback, write a
 * CustomerFollowUp, invoice, schedule, or message the customer.
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
  JOB_CUSTOMER_ISSUE_ALREADY_OPEN_MESSAGE,
  JOB_CUSTOMER_ISSUE_ATTACHMENT_INVALID_MESSAGE,
  JOB_CUSTOMER_ISSUE_COMPLETED_JOB_MESSAGE,
  JOB_CUSTOMER_ISSUE_COVERAGE_REFUSED_MESSAGE,
  JOB_CUSTOMER_ISSUE_DECISION_ALREADY_RECORDED_MESSAGE,
  JOB_CUSTOMER_ISSUE_JOB_REQUIRED_MESSAGE,
  JOB_CUSTOMER_ISSUE_OWNER_ONLY_MESSAGE,
  JOB_CUSTOMER_ISSUE_OWNER_WORKFLOW_MESSAGE,
  JOB_CUSTOMER_ISSUE_PORTAL_CLOSED_MESSAGE,
  JOB_CUSTOMER_ISSUE_PORTAL_RECEIVED_MESSAGE,
  JOB_CUSTOMER_ISSUE_PORTAL_UNAVAILABLE_MESSAGE,
  JOB_CUSTOMER_ISSUE_PORTAL_WORKFLOW_MESSAGE,
  JOB_CUSTOMER_ISSUE_RECORDED_MESSAGE,
  JOB_CUSTOMER_ISSUE_UNAVAILABLE_MESSAGE,
  jobCustomerIssueWriteAllowed,
  missingJobCustomerIssueSchema,
} = await import("@/lib/job-customer-issue");
const { loadJobCustomerIssueReview } = await import("@/lib/job-customer-issue-data");
const {
  countBusinessCallbacks,
  countBusinessCommunications,
  countBusinessInvoices,
  countBusinessJobs,
  countBusinessPayments,
  jobCustomerIssueErrorMessage,
  jobCustomerIssueTestHooks,
  recordCustomerReportedIssue,
  recordCustomerReportedIssueDecision,
  reviewCustomerReportedIssue,
} = await import("@/lib/job-customer-issue-ops");
const { loadPortalJobCustomerIssueView } = await import(
  "@/lib/portal-job-customer-issue-data"
);
const { submitPortalJobCustomerIssue } = await import(
  "@/lib/portal-job-customer-issue-ops"
);
const { ProjectReportedIssue } = await import(
  "@/components/portal/project-reported-issue"
);
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const {
  JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE,
  JOB_CALLBACK_WARRANTY_DISCLAIMER,
} = await import("@/lib/job-callback");

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

const featureFiles = [
  "src/lib/job-customer-issue.ts",
  "src/lib/job-customer-issue-ops.ts",
  "src/lib/job-customer-issue-data.ts",
  "src/lib/portal-job-customer-issue-ops.ts",
  "src/lib/portal-job-customer-issue-data.ts",
  "src/app/actions/job-customer-issue.ts",
  "src/app/actions/portal-job-customer-issue.ts",
  "src/components/jobs/job-customer-issue-panel.tsx",
  "src/components/portal/project-reported-issue.tsx",
  "src/components/portal/report-job-issue-form.tsx",
];
const featureSrc = featureFiles.map(read).join("\n");
const opsSrc = read("src/lib/job-customer-issue-ops.ts");
const portalOpsSrc = read("src/lib/portal-job-customer-issue-ops.ts");
const dataSrc = read("src/lib/job-customer-issue-data.ts");
const portalDataSrc = read("src/lib/portal-job-customer-issue-data.ts");
const actionSrc = read("src/app/actions/job-customer-issue.ts");
const portalActionSrc = read("src/app/actions/portal-job-customer-issue.ts");
const formSrc = read("src/components/jobs/job-customer-issue-panel.tsx");
const portalComponentSrc = read("src/components/portal/project-reported-issue.tsx");
const portalFormSrc = read("src/components/portal/report-job-issue-form.tsx");
const pageSrc = read("src/app/(app)/jobs/[jobId]/page.tsx");
const portalSrc = read("src/app/p/[token]/page.tsx");
const schemaSrc = read("prisma/schema.prisma");
const migrationSrc = read(
  "prisma/migrations/20261002180000_job_customer_issue/migration.sql",
);
const navSrc = read("src/components/record-nav.tsx");
const mergeSrc = read("src/lib/customer-merge-ops.ts");

console.log("\nSTATIC — OWNER-only, no second queue, customer status vs private findings");
check(
  "OWNER-only write gate",
  jobCustomerIssueWriteAllowed("OWNER") === true &&
    jobCustomerIssueWriteAllowed("ADMIN") === false &&
    jobCustomerIssueWriteAllowed("MEMBER") === false &&
    opsSrc.includes("requireBusinessRole(access, \"OWNER\")") &&
    opsSrc.includes("JOB_CUSTOMER_ISSUE_OWNER_ONLY_MESSAGE"),
);
check(
  "Copy stays trade-neutral and does not invent coverage",
  !/handyman|cleaning|re-clean|corrective clean|pressure wash/i.test(featureSrc) &&
    !/COVERED|NOT_COVERED|IN_WARRANTY|OUT_OF_WARRANTY/.test(
      formSrc + actionSrc + pageSrc + portalComponentSrc + portalFormSrc,
    ) &&
    JOB_CALLBACK_WARRANTY_DISCLAIMER.includes("does not determine coverage") &&
    JOB_CUSTOMER_ISSUE_OWNER_WORKFLOW_MESSAGE.includes("does not create a callback") &&
    JOB_CUSTOMER_ISSUE_PORTAL_WORKFLOW_MESSAGE.includes("does not promise coverage") &&
    JOB_CUSTOMER_ISSUE_RECORDED_MESSAGE.includes("No invoice"),
);
check(
  "Write path does not invoice, schedule, message, or open a second queue",
  !opsSrc.includes("invoice.create") &&
    !opsSrc.includes("persistDraftInvoice") &&
    !opsSrc.includes("tx.job.create") &&
    !opsSrc.includes("payment.create") &&
    !opsSrc.includes("notifyCustomer") &&
    !opsSrc.includes("sendCustomer") &&
    !opsSrc.includes("jobCallback.create") &&
    !opsSrc.includes("customerFollowUp.create") &&
    !portalOpsSrc.includes("jobCallback.create") &&
    !portalOpsSrc.includes("customerFollowUp.create") &&
    !actionSrc.includes("notifyCustomer") &&
    !portalActionSrc.includes("notifyCustomer") &&
    !formSrc.includes("Create invoice") &&
    JOB_CUSTOMER_ISSUE_RECORDED_MESSAGE.includes("callback") &&
    JOB_CUSTOMER_ISSUE_PORTAL_CLOSED_MESSAGE.includes("not a warranty"),
);
check(
  "Does not touch CustomerFollowUp beyond the existing customer-merge remap",
  !featureSrc.includes("customerFollowUp") &&
    !featureSrc.includes("CustomerFollowUp") &&
    !opsSrc.includes("followUp") &&
    !portalOpsSrc.includes("followUp") &&
    mergeSrc.includes('model: "JobCustomerIssue"') &&
    mergeSrc.includes('delegate: "jobCustomerIssue"'),
);
check(
  "Additive issue tables and append-only events; Job columns untouched",
  schemaSrc.includes("model JobCustomerIssue") &&
    schemaSrc.includes("model JobCustomerIssueEvent") &&
    schemaSrc.includes("model JobCustomerIssueAttachment") &&
    schemaSrc.includes("customerVisibleStatus") &&
    schemaSrc.includes("ownerNotes") &&
    schemaSrc.includes("Application code must never update or delete an existing row") &&
    migrationSrc.includes('CREATE TABLE IF NOT EXISTS "JobCustomerIssue"') &&
    migrationSrc.includes('CREATE TABLE IF NOT EXISTS "JobCustomerIssueEvent"') &&
    migrationSrc.includes('CREATE TABLE IF NOT EXISTS "JobCustomerIssueAttachment"') &&
    migrationSrc.includes("20261002180000") &&
    migrationSrc.includes("JobCustomerIssue_one_open_per_job") &&
    !migrationSrc.includes('ALTER TABLE "Job"') &&
    !migrationSrc.includes('ALTER TABLE "CustomerFollowUp"') &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSrc) &&
    opsSrc.includes("jobCustomerIssueEvent.create") &&
    !opsSrc.includes("jobCustomerIssueEvent.update") &&
    !opsSrc.includes("jobCustomerIssueEvent.delete"),
);
check(
  "Owner loader is mutation-free; token loader is customer-visible only",
  dataSrc.includes("...access.scope") &&
    dataSrc.includes("loadRecordedWarrantyTerms") &&
    dataSrc.includes("ownerNotes") &&
    portalDataSrc.includes("findLiveJobByProjectToken") &&
    portalDataSrc.includes("customerVisibleStatus") &&
    !portalDataSrc.includes("ownerNotes") &&
    !portalDataSrc.includes("decision:") &&
    !portalDataSrc.includes("storageKey") &&
    !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(
      dataSrc + portalDataSrc,
    ),
);
check(
  "Loaders degrade on missing issue tables (P2021/P2022); writes fail closed",
  missingJobCustomerIssueSchema({ code: "P2021" }) &&
    missingJobCustomerIssueSchema({ code: "P2022" }) &&
    !missingJobCustomerIssueSchema({ code: "P2002" }) &&
    !missingJobCustomerIssueSchema(new Error("Can't reach database server")) &&
    dataSrc.includes("if (missingJobCustomerIssueSchema(error)) return null") &&
    portalDataSrc.includes("if (missingJobCustomerIssueSchema(error)) return { status: \"hidden\" }") &&
    opsSrc.includes("JOB_CUSTOMER_ISSUE_UNAVAILABLE_MESSAGE") &&
    jobCustomerIssueErrorMessage({ code: "P2021" }, "fallback") ===
      JOB_CUSTOMER_ISSUE_UNAVAILABLE_MESSAGE,
);
check(
  "Work Order hosts the OWNER panel; portal shows customer-visible status only",
  pageSrc.includes("JobCustomerIssuePanel") &&
    pageSrc.includes("Customer-reported issue") &&
    pageSrc.includes("create a callback") &&
    formSrc.includes("Recorded warranty terms") &&
    formSrc.includes("Private owner notes") &&
    formSrc.includes("Private decision") &&
    portalSrc.includes("loadPortalJobCustomerIssueView") &&
    portalSrc.includes("ProjectReportedIssue") &&
    portalSrc.includes("ReportJobIssueForm") &&
    portalComponentSrc.includes("JOB_CUSTOMER_ISSUE_PORTAL_HEADING") &&
    !portalComponentSrc.includes("ownerNotes") &&
    !portalComponentSrc.includes("decisionLabel") &&
    !portalComponentSrc.includes("WILL_FOLLOW_UP") &&
    !navSrc.includes("customer-issue") &&
    !navSrc.includes("Customer issue"),
);

console.log("\nBEHAVIOR — customer-visible issue text is escaped");
const xssPayload = `<script>alert("xss")</script>`;
const issueHtml = renderToStaticMarkup(
  createElement(ProjectReportedIssue, {
    issue: {
      id: "issue-xss",
      jobId: "job-xss",
      businessId: "biz-xss",
      category: "QUALITY_CONCERN",
      categoryLabel: "Quality concern",
      description: xssPayload,
      customerVisibleStatus: "RECEIVED",
      customerVisibleStatusLabel: "Received",
      preferredContact: "PHONE",
      recordedAt: new Date("2026-10-02T00:00:00.000Z"),
      attachments: [{ originalFilename: xssPayload }],
    },
    timeZone: "UTC",
  }),
);
check(
  "ProjectReportedIssue escapes script text instead of embedding HTML",
  issueHtml.includes("&lt;script&gt;") &&
    !issueHtml.includes("<script>") &&
    !issueHtml.includes(xssPayload) &&
    !portalComponentSrc.includes("dangerouslySetInnerHTML"),
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

  const invoicesBefore = await countBusinessInvoices(prisma, businessA.id);
  const jobsBefore = await countBusinessJobs(prisma, businessA.id);
  const paymentsBefore = await countBusinessPayments(prisma, businessA.id);
  const commsBefore = await countBusinessCommunications(prisma, businessA.id);
  const callbacksBefore = await countBusinessCallbacks(prisma, businessA.id);
  const followUpsBefore = await prisma.customerFollowUp.count({
    where: { businessId: businessA.id },
  });

  console.log("\nAUTH — ADMIN and MEMBER cannot write");
  await expectThrow(
    "ADMIN cannot record an issue",
    () =>
      recordCustomerReportedIssue(prisma, adminA, {
        jobId: completedA.id,
        category: "QUALITY_CONCERN",
        description: "Paint peel",
        reportedVia: "PHONE",
      }),
    (error) =>
      error instanceof ForbiddenError &&
      jobCustomerIssueErrorMessage(error, "") === JOB_CUSTOMER_ISSUE_OWNER_ONLY_MESSAGE,
  );
  await expectThrow(
    "MEMBER cannot record a decision",
    () =>
      recordCustomerReportedIssueDecision(prisma, memberA, {
        issueId: "missing",
        decision: "RECORDED_ONLY",
      }),
    (error) => error instanceof ForbiddenError,
  );

  console.log("\nELIGIBILITY — completed same-business job only");
  await expectThrow(
    "In-progress job is refused",
    () =>
      recordCustomerReportedIssue(prisma, ownerA, {
        jobId: inProgressA.id,
        category: "QUALITY_CONCERN",
        description: "Too early",
        reportedVia: "PHONE",
      }),
    (error) =>
      error.name === "JobCustomerIssueError" &&
      error.message === JOB_CUSTOMER_ISSUE_COMPLETED_JOB_MESSAGE,
  );
  await expectThrow(
    "Foreign completed job is isolated",
    () =>
      recordCustomerReportedIssue(prisma, ownerA, {
        jobId: completedB.id,
        category: "QUALITY_CONCERN",
        description: "Cross tenant",
        reportedVia: "PHONE",
      }),
    (error) =>
      error.name === "JobCustomerIssueError" &&
      error.message === JOB_CUSTOMER_ISSUE_JOB_REQUIRED_MESSAGE,
  );
  const inProgressPortal = await submitPortalJobCustomerIssue(prisma, {
    token: inProgressA.projectToken,
    category: "QUALITY_CONCERN",
    description: "Portal too early",
    preferredContact: "PHONE",
  });
  check(
    "Portal hides or refuses an in-progress job",
    inProgressPortal.ok === false &&
      (inProgressPortal.error === JOB_CUSTOMER_ISSUE_PORTAL_UNAVAILABLE_MESSAGE ||
        inProgressPortal.error.includes("complete")),
  );

  console.log("\nPORTAL SUBMIT — token/job isolation and duplicates");
  const firstPortal = await submitPortalJobCustomerIssue(prisma, {
    token: tokenA,
    category: "QUALITY_CONCERN",
    description: "The latch sticks after the visit.",
    preferredContact: "TEXT",
    storedAssetIds: [privateDocA.id],
  });
  check(
    "Portal records a structured issue for the token-scoped job",
    firstPortal.ok === true &&
      firstPortal.alreadyExists === false &&
      firstPortal.jobId === completedA.id,
  );
  const duplicatePortal = await submitPortalJobCustomerIssue(prisma, {
    token: tokenA,
    category: "DAMAGE",
    description: "A second tap should not open another issue.",
    preferredContact: "EMAIL",
  });
  check(
    "Duplicate portal submit is idempotent on the open issue",
    duplicatePortal.ok === true &&
      duplicatePortal.alreadyExists === true &&
      duplicatePortal.issueId === firstPortal.issueId,
  );
  const foreignTokenSubmit = await submitPortalJobCustomerIssue(prisma, {
    token: tokenB,
    category: "QUALITY_CONCERN",
    description: "Trying to attach Alpha's job",
    preferredContact: "PHONE",
    storedAssetIds: [privateDocA.id],
  });
  check(
    "Foreign token cannot attach Alpha's document to Beta",
    foreignTokenSubmit.ok === false,
  );
  const sisterTokenSubmit = await submitPortalJobCustomerIssue(prisma, {
    token: tokenA2,
    category: "QUALITY_CONCERN",
    description: "Sister token should not land on job A",
    preferredContact: "PHONE",
    storedAssetIds: [privateDocA.id],
  });
  check(
    "Same-business sister token cannot attach job A's document",
    sisterTokenSubmit.ok === false,
  );
  const openRows = await prisma.jobCustomerIssue.findMany({
    where: { jobId: completedA.id, businessId: businessA.id },
  });
  check("Exactly one Alpha issue exists after duplicate taps", openRows.length === 1);
  const betaRows = await prisma.jobCustomerIssue.findMany({
    where: { jobId: completedB.id, businessId: businessB.id },
  });
  check("Failed foreign/sister submits did not create a Beta issue", betaRows.length === 0);

  const portalView = await loadPortalJobCustomerIssueView(prisma, tokenA);
  const portalViewJson = JSON.stringify(portalView);
  check(
    "Token view is already_reported and omits private findings and storage keys",
    portalView.status === "already_reported" &&
      portalView.jobId === completedA.id &&
      portalView.issues[0]?.customerVisibleStatus === "RECEIVED" &&
      portalView.issues[0]?.attachments[0]?.originalFilename === "job-a-photo.pdf" &&
      !portalViewJson.includes("ownerNotes") &&
      !portalViewJson.includes("WILL_FOLLOW_UP") &&
      !portalViewJson.includes(privateDocA.storageKey) &&
      !portalViewJson.includes("secret-a"),
  );
  const sisterView = await loadPortalJobCustomerIssueView(prisma, tokenA2);
  check(
    "Sister token cannot read job A's issue",
    sisterView.status === "ready" &&
      sisterView.jobId === completedA2.id &&
      sisterView.issues.length === 0,
  );
  const betaView = await loadPortalJobCustomerIssueView(prisma, tokenB);
  check(
    "Foreign token cannot read Alpha's issue",
    betaView.status === "ready" &&
      betaView.jobId === completedB.id &&
      !JSON.stringify(betaView).includes("latch sticks"),
  );
  check(
    "Unknown token is hidden",
    (await loadPortalJobCustomerIssueView(prisma, "missing-token")).status === "hidden",
  );

  console.log("\nOWNER REVIEW — private notes stay off the token");
  const ownerReview = await loadJobCustomerIssueReview(prisma, ownerA, completedA.id);
  check(
    "OWNER review includes the portal report and attachable private documents",
    ownerReview?.issues[0]?.id === firstPortal.issueId &&
      ownerReview?.issues[0]?.description.includes("latch sticks") &&
      ownerReview?.issues[0]?.attachments[0]?.originalFilename === "job-a-photo.pdf" &&
      ownerReview?.attachableDocuments.some((doc) => doc.id === privateDocA.id) === true,
  );
  const reviewed = await reviewCustomerReportedIssue(prisma, ownerA, {
    issueId: firstPortal.issueId,
    ownerNotes: "SECRET owner finding: hinge was already worn.",
  });
  check(
    "Review moves customer-visible status to IN_REVIEW and stores private notes",
    reviewed.issue.customerVisibleStatus === "IN_REVIEW" &&
      reviewed.issue.ownerNotes.includes("SECRET owner finding"),
  );
  const tokenAfterReview = await loadPortalJobCustomerIssueView(prisma, tokenA);
  const tokenAfterReviewJson = JSON.stringify(tokenAfterReview);
  check(
    "Token sees In review without owner notes or a decision",
    tokenAfterReview.issues[0]?.customerVisibleStatus === "IN_REVIEW" &&
      tokenAfterReview.issues[0]?.customerVisibleStatusLabel === "In review" &&
      !tokenAfterReviewJson.includes("SECRET owner finding") &&
      !tokenAfterReviewJson.includes("decision") &&
      !tokenAfterReviewJson.includes("hinge was already worn"),
  );
  const foreignOwnerReview = await loadJobCustomerIssueReview(prisma, ownerA, completedB.id);
  check("Foreign job owner review is null", foreignOwnerReview === null);
  await expectThrow(
    "Alpha cannot decide a missing Beta issue",
    () =>
      recordCustomerReportedIssueDecision(prisma, ownerA, {
        issueId: firstPortal.issueId + "-nope",
        decision: "RECORDED_ONLY",
      }),
    (error) => error.message === "That issue could not be found.",
  );

  console.log("\nATTACHMENTS — existing private storage only");
  await expectThrow(
    "Sister-job private document cannot attach to this job",
    () =>
      recordCustomerReportedIssue(prisma, ownerA, {
        jobId: completedA2.id,
        category: "DAMAGE",
        description: "Wrong document",
        reportedVia: "EMAIL",
        storedAssetIds: [privateDocA.id],
      }),
    (error) => error.message === JOB_CUSTOMER_ISSUE_ATTACHMENT_INVALID_MESSAGE,
  );
  await expectThrow(
    "Public document cannot attach",
    () =>
      recordCustomerReportedIssue(prisma, ownerA, {
        jobId: completedA2.id,
        category: "DAMAGE",
        description: "Public file",
        reportedVia: "EMAIL",
        storedAssetIds: [publicDocA.id],
      }),
    (error) => error.message === JOB_CUSTOMER_ISSUE_ATTACHMENT_INVALID_MESSAGE,
  );
  await expectThrow(
    "Foreign-business document cannot attach",
    () =>
      recordCustomerReportedIssue(prisma, ownerA, {
        jobId: completedA2.id,
        category: "DAMAGE",
        description: "Beta file",
        reportedVia: "EMAIL",
        storedAssetIds: [privateDocB.id],
      }),
    (error) => error.message === JOB_CUSTOMER_ISSUE_ATTACHMENT_INVALID_MESSAGE,
  );
  const attachedSister = await recordCustomerReportedIssue(prisma, ownerA, {
    jobId: completedA2.id,
    category: "INCOMPLETE_WORK",
    description: "Sister job with its own private document.",
    reportedVia: "PHONE",
    storedAssetIds: [sisterDocA.id],
  });
  check(
    "Same-job private document attaches",
    attachedSister.issue.jobId === completedA2.id,
  );
  const sisterOwner = await loadJobCustomerIssueReview(prisma, ownerA, completedA2.id);
  check(
    "Attached filename is recorded without leaking the storage key",
    sisterOwner?.issues[0]?.attachments[0]?.originalFilename === "sister-job.pdf" &&
      !JSON.stringify(sisterOwner?.issues[0]?.attachments ?? []).includes(
        sisterDocA.storageKey,
      ),
  );

  console.log("\nCONCURRENCY — parallel decisions share the FOR UPDATE job lock");
  const raceIssue = await recordCustomerReportedIssue(prisma, ownerA, {
    jobId: (await createJob(businessA.id, { token: `race-${suffix}` })).id,
    category: "NOT_WORKING",
    description: "One decision only.",
    reportedVia: "PHONE",
  });
  const decideBarrier = createWriteBarrier(8, 8000);
  jobCustomerIssueTestHooks.beforeJobLock = async ({ kind }) => {
    if (kind === "decide") await decideBarrier.arriveAndWait();
  };
  const raceClients = Array.from({ length: 8 }, () => session.createClient());
  try {
    const raceResults = await Promise.allSettled(
      raceClients.map((client, index) =>
        recordCustomerReportedIssueDecision(client, ownerA, {
          issueId: raceIssue.issue.id,
          decision: index === 0 ? "WILL_FOLLOW_UP" : "RECORDED_ONLY",
          ownerNotes: index === 0 ? "First writer" : `Racer ${index}`,
        }),
      ),
    );
    const decidedEvents = await prisma.jobCustomerIssueEvent.count({
      where: {
        businessId: businessA.id,
        issueId: raceIssue.issue.id,
        eventType: "DECIDED",
      },
    });
    const closed = await prisma.jobCustomerIssue.findFirst({
      where: { id: raceIssue.issue.id, businessId: businessA.id },
    });
    const fulfilled = raceResults.filter((result) => result.status === "fulfilled");
    const rejected = raceResults.filter((result) => result.status === "rejected");
    check(
      "Eight parallel decisions produce exactly one DECIDED event and one CLOSED row",
      decidedEvents === 1 &&
        closed?.customerVisibleStatus === "CLOSED" &&
        Boolean(closed?.decision) &&
        fulfilled.length + rejected.length === 8 &&
        fulfilled.length >= 1,
    );
    check(
      "Losing writers do not overwrite the recorded decision",
      closed?.decision === "WILL_FOLLOW_UP" || closed?.decision === "RECORDED_ONLY",
    );
  } finally {
    jobCustomerIssueTestHooks.beforeJobLock = undefined;
    await Promise.all(raceClients.map((client) => client.$disconnect()));
  }

  console.log("\nCLOSED CASE — decision is final; token stays customer-visible only");
  const decided = await recordCustomerReportedIssueDecision(prisma, ownerA, {
    issueId: firstPortal.issueId,
    decision: "WILL_FOLLOW_UP",
    ownerNotes: "SECRET owner finding: hinge was already worn. Follow up next week.",
  });
  check(
    "Decision closes the customer-visible status",
    decided.issue.customerVisibleStatus === "CLOSED" &&
      decided.issue.decision === "WILL_FOLLOW_UP",
  );
  await expectThrow(
    "Coverage outcomes are refused",
    () =>
      recordCustomerReportedIssueDecision(prisma, ownerA, {
        issueId: firstPortal.issueId,
        decision: "COVERED",
      }),
    (error) => error.message === JOB_CUSTOMER_ISSUE_COVERAGE_REFUSED_MESSAGE,
  );
  await expectThrow(
    "A different decision on a closed issue is refused",
    () =>
      recordCustomerReportedIssueDecision(prisma, ownerA, {
        issueId: firstPortal.issueId,
        decision: "NO_RETURN_VISIT",
        ownerNotes: "changed my mind",
      }),
    (error) => error.message === JOB_CUSTOMER_ISSUE_DECISION_ALREADY_RECORDED_MESSAGE,
  );
  const closedToken = await loadPortalJobCustomerIssueView(prisma, tokenA);
  const closedTokenJson = JSON.stringify(closedToken);
  check(
    "Closed token view shows Closed without private findings",
    closedToken.status === "ready" &&
      closedToken.issues[0]?.customerVisibleStatus === "CLOSED" &&
      closedToken.issues[0]?.customerVisibleStatusLabel === "Closed" &&
      closedToken.issues[0]?.description.includes("latch sticks") &&
      !closedTokenJson.includes("WILL_FOLLOW_UP") &&
      !closedTokenJson.includes("SECRET owner finding") &&
      !closedTokenJson.includes("hinge was already worn") &&
      !closedTokenJson.includes(privateDocA.storageKey),
  );
  const ownerClosed = await loadJobCustomerIssueReview(prisma, ownerA, completedA.id);
  check(
    "OWNER still sees the private decision and notes after close",
    ownerClosed?.issues[0]?.decision === "WILL_FOLLOW_UP" &&
      ownerClosed?.issues[0]?.ownerNotes.includes("SECRET owner finding") &&
      ownerClosed?.issues[0]?.customerVisibleStatus === "CLOSED",
  );
  const refill = await submitPortalJobCustomerIssue(prisma, {
    token: tokenA,
    category: "OTHER",
    description: "A later report after the first case closed.",
    preferredContact: "PHONE",
  });
  check(
    "A new portal report is allowed after the previous case is closed",
    refill.ok === true &&
      refill.alreadyExists === false &&
      refill.issueId !== firstPortal.issueId,
  );

  console.log("\nWARRANTY — display recorded terms only");
  const review = await loadJobCustomerIssueReview(prisma, ownerA, completedA.id);
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
  const emptyReview = await loadJobCustomerIssueReview(prisma, ownerC, emptyJob.id);
  check(
    "Business without recorded warranty terms says none are recorded",
    emptyReview?.warrantyTerms.length === 0 &&
      emptyReview?.noWarrantyTermsMessage === JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE,
  );

  console.log("\nSIDE EFFECTS — no invoice, callback, follow-up, or customer message");
  check(
    "Invoice / job / payment / communication / callback / follow-up counts unchanged",
    (await countBusinessInvoices(prisma, businessA.id)) === invoicesBefore &&
      (await countBusinessJobs(prisma, businessA.id)) === jobsBefore + 1 &&
      (await countBusinessPayments(prisma, businessA.id)) === paymentsBefore &&
      (await countBusinessCommunications(prisma, businessA.id)) === commsBefore &&
      (await countBusinessCallbacks(prisma, businessA.id)) === callbacksBefore &&
      (await prisma.customerFollowUp.count({ where: { businessId: businessA.id } })) ===
        followUpsBefore,
  );
  const callbackRows = await prisma.jobCallback.count({
    where: { businessId: { in: [businessA.id, businessB.id, businessC.id] } },
  });
  check("No JobCallback row was created for these issue events", callbackRows === 0);

  console.log("\nMISSING SCHEMA — loaders degrade; writes fail closed");
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "JobCustomerIssueAttachment" CASCADE`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "JobCustomerIssueEvent" CASCADE`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "JobCustomerIssue" CASCADE`);
  const missingTables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('JobCustomerIssue', 'JobCustomerIssueEvent', 'JobCustomerIssueAttachment')
  `;
  check("Issue tables are absent after the drop", missingTables.length === 0);

  let tokenMissingError = null;
  let tokenMissing = "threw";
  try {
    tokenMissing = await loadPortalJobCustomerIssueView(prisma, tokenA);
  } catch (error) {
    tokenMissingError = error;
  }
  let ownerMissingError = null;
  let ownerMissing = "threw";
  try {
    ownerMissing = await loadJobCustomerIssueReview(prisma, ownerA, completedA.id);
  } catch (error) {
    ownerMissingError = error;
  }
  check(
    "Token loader hides the card without throwing when issue tables are missing",
    tokenMissing?.status === "hidden" && tokenMissingError === null,
  );
  check(
    "Owner loader returns null without throwing when issue tables are missing",
    ownerMissing === null && ownerMissingError === null,
  );
  await expectThrow(
    "Record fail-closes with a clear setup-pending error when tables are missing",
    () =>
      recordCustomerReportedIssue(prisma, ownerA, {
        jobId: completedA.id,
        category: "OTHER",
        description: "Should fail closed",
        reportedVia: "PHONE",
      }),
    (error) =>
      error.name === "JobCustomerIssueError" &&
      error.message === JOB_CUSTOMER_ISSUE_UNAVAILABLE_MESSAGE,
  );
  const stillMissing = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('JobCustomerIssue', 'JobCustomerIssueEvent', 'JobCustomerIssueAttachment')
  `;
  check(
    "Failed writes do not recreate the dropped issue tables",
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
    ? `\nAll job-customer-issue checks passed (${passed}).`
    : `\n${failed} job-customer-issue check(s) failed.`,
);
process.exitCode = failed === 0 ? 0 : 1;

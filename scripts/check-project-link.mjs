/**
 * OWNER rotate / revoke of an existing job's public project link.
 *
 * Dedicated local disposable database (name prefix tbbt_project_link).
 *
 * Proves OWNER authorization, token isolation, concurrent rotations,
 * and old-form submission refusal. Historical Job/invoice/communication
 * rows stay. The action does not send a customer message.
 *
 * Run with:
 *   npm run test:project-link
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

register(new URL("./project-link-test-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for project-link checks.");
  process.exit(generateEarly.status ?? 1);
}

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const { createCustomerAdditionalWorkRequest } = await import(
  "@/lib/additional-work-request"
);
const {
  JOB_PROJECT_LINK_ALREADY_REVOKED_MESSAGE,
  JOB_PROJECT_LINK_CONFLICT_MESSAGE,
  JOB_PROJECT_LINK_JOB_REQUIRED_MESSAGE,
  JOB_PROJECT_LINK_OWNER_ONLY_MESSAGE,
  JOB_PROJECT_LINK_OWNER_WORKFLOW_MESSAGE,
  JOB_PROJECT_LINK_REVOKED_MESSAGE,
  JOB_PROJECT_LINK_ROTATED_MESSAGE,
  JOB_PROJECT_LINK_UNAVAILABLE_MESSAGE,
  jobProjectLinkWriteAllowed,
  missingJobProjectLinkSchema,
  projectLinkTokenAuditValue,
} = await import("@/lib/project-link");
const {
  assertLiveLockedProjectToken,
  findLiveJobByProjectToken,
  isLiveProjectToken,
  liveOutboundProjectToken,
  loadJobProjectLinkReview,
} = await import("@/lib/project-link-data");
const {
  countBusinessCommunications,
  countBusinessInvoices,
  countBusinessJobs,
  countBusinessPayments,
  jobProjectLinkErrorMessage,
  jobProjectLinkTestHooks,
  revokeJobProjectLink,
  rotateJobProjectLink,
} = await import("@/lib/project-link-ops");
const { loadPortalJobCallbackView } = await import("@/lib/portal-job-callback-data");
const {
  portalJobCallbackTestHooks,
  submitPortalJobCallback,
} = await import("@/lib/portal-job-callback-ops");
const { loadPortalCustomerCommunications } = await import(
  "@/lib/portal-project-home"
);
const { JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE } = await import(
  "@/lib/job-callback"
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the project-link check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "project-link dedicated local database");

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
      business: { id: businessId, name: "Project Link Co" },
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
  "src/lib/project-link.ts",
  "src/lib/project-link-ops.ts",
  "src/lib/project-link-data.ts",
  "src/app/actions/project-link.ts",
  "src/components/jobs/project-link-panel.tsx",
];
const featureSrc = featureFiles.map(read).join("\n");
const opsSrc = read("src/lib/project-link-ops.ts");
const dataSrc = read("src/lib/project-link-data.ts");
const actionSrc = read("src/app/actions/project-link.ts");
const formSrc = read("src/components/jobs/project-link-panel.tsx");
const pageSrc = read("src/app/(app)/jobs/[jobId]/page.tsx");
const portalSrc = read("src/app/p/[token]/page.tsx");
const schemaSrc = read("prisma/schema.prisma");
const migrationSrc = read("prisma/migrations/20261002050000_job_project_link/migration.sql");
const callbackOpsSrc = read("src/lib/portal-job-callback-ops.ts");
const documentSrc = read("src/lib/business-storage/project-documents.ts");
const appointmentNotifySrc = read("src/lib/appointment-notify.ts");
const automationEmailSrc = read("src/lib/automation/email.ts");
const completeInvoiceSrc = read("src/lib/complete-job-invoice.ts");
const messagingSrc = read("src/lib/customer-messaging/workflows.ts");
const dayRouteSrc = read("src/lib/owner-day-route-appointment-notice-ops.ts");
const appointmentActionSrc = read("src/app/actions/public-appointment.ts");
const changeOrderActionSrc = read("src/app/actions/public-change-order.ts");

console.log("\nSTATIC — OWNER-only rotate/revoke, no message, additive history");
check(
  "OWNER-only write gate",
  jobProjectLinkWriteAllowed("OWNER") === true &&
    jobProjectLinkWriteAllowed("ADMIN") === false &&
    jobProjectLinkWriteAllowed("MEMBER") === false &&
    opsSrc.includes("requireBusinessRole(access, \"OWNER\")") &&
    opsSrc.includes("JOB_PROJECT_LINK_OWNER_ONLY_MESSAGE"),
);
check(
  "Write path does not invoice, schedule, or message",
  !opsSrc.includes("invoice.create") &&
    !opsSrc.includes("persistDraftInvoice") &&
    !opsSrc.includes("completeJobAndDraftInvoice") &&
    !opsSrc.includes("tx.job.create") &&
    !opsSrc.includes("payment.create") &&
    !opsSrc.includes("notifyCustomer") &&
    !opsSrc.includes("sendCustomer") &&
    !opsSrc.includes("emitAndProcessBusinessEvent") &&
    !actionSrc.includes("invoice.create") &&
    !actionSrc.includes("notifyCustomer") &&
    JOB_PROJECT_LINK_ROTATED_MESSAGE.includes("No customer message") &&
    JOB_PROJECT_LINK_REVOKED_MESSAGE.includes("No customer message") &&
    JOB_PROJECT_LINK_OWNER_WORKFLOW_MESSAGE.includes("does not send a message"),
);
check(
  "Additive project-link tables and append-only events; no Job column ALTER",
  schemaSrc.includes("model JobProjectLink") &&
    schemaSrc.includes("model JobProjectLinkEvent") &&
    schemaSrc.includes("Application code must never update or delete an existing row") &&
    migrationSrc.includes('CREATE TABLE IF NOT EXISTS "JobProjectLink"') &&
    migrationSrc.includes('CREATE TABLE IF NOT EXISTS "JobProjectLinkEvent"') &&
    !migrationSrc.includes('ALTER TABLE "Job"') &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSrc) &&
    opsSrc.includes("jobProjectLinkEvent.create") &&
    !opsSrc.includes("jobProjectLinkEvent.update") &&
    !opsSrc.includes("jobProjectLinkEvent.delete"),
);
check(
  "Live-token resolver is the portal and action lookup",
  dataSrc.includes("findLiveJobByProjectToken") &&
    dataSrc.includes('link?.status !== "REVOKED"') &&
    portalSrc.includes("findLiveJobByProjectToken") &&
    read("src/app/actions/public-appointment.ts").includes("findLiveJobByProjectToken") &&
    read("src/app/actions/public-change-order.ts").includes("findLiveJobByProjectToken") &&
    read("src/lib/additional-work-request.ts").includes("findLiveJobByProjectToken"),
);
check(
  "Work Order hosts the OWNER panel; rotate/revoke stay on the same job",
  pageSrc.includes("ProjectLinkPanel") &&
    pageSrc.includes("Customer Project Portal") &&
    formSrc.includes("Rotate project link") &&
    formSrc.includes("Revoke project link") &&
    formSrc.includes("does not send a message") &&
    !/handyman|cleaning|re-clean|corrective clean/i.test(featureSrc),
);
check(
  "Missing tables fail writes closed and degrade live reads",
  missingJobProjectLinkSchema({ code: "P2021" }) &&
    missingJobProjectLinkSchema({ code: "P2022" }) &&
    !missingJobProjectLinkSchema({ code: "P2002" }) &&
    jobProjectLinkErrorMessage({ code: "P2021" }, "fallback") ===
      JOB_PROJECT_LINK_UNAVAILABLE_MESSAGE &&
    dataSrc.includes('to_regclass(\'"JobProjectLink"\')') &&
    dataSrc.includes("jobProjectLinkTablesPresent"),
);
check(
  "Customer writes re-validate the supplied token after Job FOR UPDATE",
  callbackOpsSrc.includes("assertLiveLockedProjectToken") &&
    callbackOpsSrc.includes("afterJobLock") &&
    callbackOpsSrc.indexOf("await lockTenantOwnedJob") <
      callbackOpsSrc.indexOf("assertLiveLockedProjectToken(tx") &&
    callbackOpsSrc.indexOf("assertLiveLockedProjectToken(tx") <
      callbackOpsSrc.indexOf("isPortalJobCallbackCoolingDown(") &&
    documentSrc.includes("assertLiveLockedProjectToken") &&
    documentSrc.indexOf("await lockJobForProjectDocument") <
      documentSrc.indexOf("assertLiveLockedProjectToken(tx"),
);
check(
  "Audit nextToken stores a hash/last4, not the live token",
  opsSrc.includes("projectLinkTokenAuditValue") &&
    schemaSrc.includes("Never the raw") &&
    projectLinkTokenAuditValue("live-token-secret").endsWith("cret") &&
    !projectLinkTokenAuditValue("live-token-secret").includes("live-token-secret"),
);
check(
  "Revoke and rotate-after-revoke require a confirmation step",
  formSrc.includes("window.confirm") &&
    formSrc.includes("Revoke this customer project link") &&
    formSrc.includes("Issue a new customer project link") &&
    formSrc.includes("confirmAfterRevoke"),
);
check(
  "Outbound customer URLs are gated on live link status",
  appointmentNotifySrc.includes("liveOutboundProjectToken") &&
    automationEmailSrc.includes("liveOutboundProjectToken") &&
    completeInvoiceSrc.includes("liveOutboundProjectToken") &&
    messagingSrc.includes("liveOutboundProjectToken") &&
    dayRouteSrc.includes("liveOutboundProjectToken"),
);
check(
  "Appointment and change-order actions use the live-token resolver",
  appointmentActionSrc.includes("findLiveJobByProjectToken") &&
    changeOrderActionSrc.includes("findLiveJobByProjectToken"),
);

let session;
try {
  session = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_project_link",
    setProcessEnv: true,
  });
  const prisma = session.prisma;
  const { loadInvoiceDocumentForProjectToken } = await import(
    "@/lib/invoice-document"
  );
  check(
    "Dedicated local disposable database opened",
    Boolean(session.testDbName?.startsWith("tbbt_project_link_")),
  );

  const suffix = randomUUID().slice(0, 8);
  const ownerUser = await prisma.user.create({
    data: { name: "Owen", email: `owner-pl-${suffix}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ada", email: `admin-pl-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mel", email: `member-pl-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-pl-${suffix}@example.com`, passwordHash: "x" },
  });

  const businessA = await prisma.business.create({
    data: { name: "Alpha Links", slug: `alpha-pl-${suffix}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Links", slug: `beta-pl-${suffix}`, tradeCode: "HANDYMAN" },
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

  const ownerA = makeAccess(businessA.id, "OWNER", memOwnerA.id, ownerUser.id);
  const adminA = makeAccess(businessA.id, "ADMIN", memAdminA.id, adminUser.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memMemberA.id, memberUser.id);
  const ownerB = makeAccess(businessB.id, "OWNER", memOwnerB.id, ownerBUser.id);

  async function createJob(businessId, options = {}) {
    const { status = "SCHEDULED", token } = options;
    const customer = await prisma.customer.create({
      data: {
        businessId,
        name: "Portal Customer",
        email: `cust-${randomUUID().slice(0, 6)}@example.com`,
      },
    });
    return prisma.job.create({
      data: {
        businessId,
        customerId: customer.id,
        status,
        projectToken: token ?? randomUUID(),
      },
    });
  }

  const tokenA = `portal-a-${suffix}`;
  const tokenA2 = `portal-a2-${suffix}`;
  const tokenB = `portal-b-${suffix}`;
  const jobA = await createJob(businessA.id, { token: tokenA });
  const jobA2 = await createJob(businessA.id, { token: tokenA2 });
  const jobB = await createJob(businessB.id, { token: tokenB });

  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      customerId: jobA.customerId,
      status: "SENT",
      total: 88,
    },
  });
  await prisma.customerCommunication.create({
    data: {
      businessId: businessA.id,
      customerId: jobA.customerId,
      channel: "EMAIL",
      direction: "OUTBOUND",
      purpose: "JOB_UPDATE",
      status: "SENT",
      provider: "TEST",
      idempotencyKey: `project-link-${suffix}`,
      bodySnapshot: `See /p/${tokenA}`,
      relatedType: "JOB",
      relatedId: jobA.id,
    },
  });

  const invoicesBefore = await countBusinessInvoices(prisma, businessA.id);
  const jobsBefore = await countBusinessJobs(prisma, businessA.id);
  const paymentsBefore = await countBusinessPayments(prisma, businessA.id);
  const commsBefore = await countBusinessCommunications(prisma, businessA.id);

  const firstForm = await createCustomerAdditionalWorkRequest(prisma, {
    token: tokenA,
    notes: "Please also check the hallway outlet.",
  });
  check(
    "Current token can submit a portal form before rotate",
    firstForm.ok === true && firstForm.jobId === jobA.id,
  );

  console.log("\nAUTH — ADMIN and MEMBER cannot write; foreign OWNER is refused");
  await expectThrow(
    "ADMIN cannot rotate",
    () => rotateJobProjectLink(prisma, adminA, { jobId: jobA.id }),
    (error) =>
      error instanceof ForbiddenError &&
      jobProjectLinkErrorMessage(error, "") === JOB_PROJECT_LINK_OWNER_ONLY_MESSAGE,
  );
  await expectThrow(
    "MEMBER cannot revoke",
    () => revokeJobProjectLink(prisma, memberA, { jobId: jobA.id }),
    (error) => error instanceof ForbiddenError,
  );
  await expectThrow(
    "Foreign OWNER cannot rotate another business job",
    () => rotateJobProjectLink(prisma, ownerB, { jobId: jobA.id }),
    (error) =>
      error?.name === "JobProjectLinkError" &&
      error.message === JOB_PROJECT_LINK_JOB_REQUIRED_MESSAGE,
  );

  const stillA = await prisma.job.findUnique({
    where: { id: jobA.id },
    select: { projectToken: true, businessId: true },
  });
  check(
    "Failed foreign/admin writes left job A token and business unchanged",
    stillA?.projectToken === tokenA && stillA.businessId === businessA.id,
  );

  console.log("\nROTATE — new token stays on the same job; old token is dead");
  const rotated = await rotateJobProjectLink(prisma, ownerA, { jobId: jobA.id });
  check(
    "Rotate returns a new token for the same business and job",
    rotated.jobId === jobA.id &&
      rotated.businessId === businessA.id &&
      rotated.previousToken === tokenA &&
      rotated.projectToken !== tokenA &&
      rotated.projectPath === `/p/${rotated.projectToken}`,
  );

  const afterRotate = await prisma.job.findUnique({
    where: { id: jobA.id },
    select: { projectToken: true, businessId: true, customerId: true },
  });
  check(
    "Job row stayed on the same business and customer",
    afterRotate?.businessId === businessA.id &&
      afterRotate.customerId === jobA.customerId &&
      afterRotate.projectToken === rotated.projectToken,
  );
  check(
    "Old token is not live; new token is live",
    (await isLiveProjectToken(prisma, tokenA)) === false &&
      (await isLiveProjectToken(prisma, rotated.projectToken)) === true &&
      (await findLiveJobByProjectToken(prisma, tokenA, { id: true })) === null &&
      (await findLiveJobByProjectToken(prisma, rotated.projectToken, { id: true }))?.id ===
        jobA.id,
  );
  check(
    "Sibling job and foreign job tokens are unchanged",
    (await prisma.job.findUnique({ where: { id: jobA2.id } }))?.projectToken === tokenA2 &&
      (await prisma.job.findUnique({ where: { id: jobB.id } }))?.projectToken === tokenB &&
      (await isLiveProjectToken(prisma, tokenA2)) === true &&
      (await isLiveProjectToken(prisma, tokenB)) === true,
  );

  const oldForm = await createCustomerAdditionalWorkRequest(prisma, {
    token: tokenA,
    notes: "Stale form after rotate.",
  });
  const newForm = await createCustomerAdditionalWorkRequest(prisma, {
    token: rotated.projectToken,
    notes: "Fresh form on the new link.",
  });
  check(
    "Old-form submission is refused; new token still accepts the same job",
    oldForm.ok === false &&
      oldForm.error === "This project link is not available." &&
      newForm.ok === true &&
      newForm.jobId === jobA.id,
  );

  const invoiceOld = await loadInvoiceDocumentForProjectToken(tokenA, prisma);
  const invoiceNew = await loadInvoiceDocumentForProjectToken(
    rotated.projectToken,
    prisma,
  );
  const commsOld = await loadPortalCustomerCommunications(prisma, tokenA);
  const commsNew = await loadPortalCustomerCommunications(
    prisma,
    rotated.projectToken,
  );
  check(
    "Invoice and portal-message loaders refuse the old token",
    invoiceOld === null &&
      invoiceNew != null &&
      commsOld.length === 0 &&
      commsNew.length === 1,
  );

  const review = await loadJobProjectLinkReview(prisma, ownerA, jobA.id);
  check(
    "Owner review shows the live token and a ROTATED audit event",
    review?.link.active === true &&
      review.link.projectToken === rotated.projectToken &&
      review.history[0]?.eventType === "ROTATED" &&
      review.canWrite === true,
  );

  const storedEvent = await prisma.jobProjectLinkEvent.findFirst({
    where: { jobId: jobA.id, eventType: "ROTATED" },
    orderBy: { createdAt: "desc" },
  });
  check(
    "Audit event keeps the retired token and a hash/last4 of the new token",
    storedEvent?.previousToken === tokenA &&
      storedEvent.nextToken === projectLinkTokenAuditValue(rotated.projectToken) &&
      storedEvent.nextToken !== rotated.projectToken &&
      !String(storedEvent.nextToken).includes(rotated.projectToken) &&
      storedEvent.businessId === businessA.id &&
      storedEvent.actorMembershipId === memOwnerA.id,
  );

  console.log("\nREVOKE — current and old tokens both refuse; history stays");
  const revoked = await revokeJobProjectLink(prisma, ownerA, { jobId: jobA.id });
  const burned = (
    await prisma.job.findUnique({
      where: { id: jobA.id },
      select: { projectToken: true },
    })
  )?.projectToken;
  check(
    "Revoke reports the previous live token and replaces it",
    revoked.unchanged === false &&
      revoked.previousToken === rotated.projectToken &&
      burned !== rotated.projectToken &&
      burned !== tokenA,
  );
  check(
    "Old, rotated, and burned tokens are all refused",
    (await isLiveProjectToken(prisma, tokenA)) === false &&
      (await isLiveProjectToken(prisma, rotated.projectToken)) === false &&
      (await isLiveProjectToken(prisma, burned)) === false &&
      (await findLiveJobByProjectToken(prisma, burned, { id: true })) === null,
  );
  const revokedForm = await createCustomerAdditionalWorkRequest(prisma, {
    token: rotated.projectToken,
    notes: "Should not land after revoke.",
  });
  const burnedForm = await createCustomerAdditionalWorkRequest(prisma, {
    token: burned,
    notes: "Burned token must not work.",
  });
  check(
    "Portal forms refuse the revoked and burned tokens",
    revokedForm.ok === false && burnedForm.ok === false,
  );
  const revokedReview = await loadJobProjectLinkReview(prisma, ownerA, jobA.id);
  check(
    "Owner review hides the burned token after revoke",
    revokedReview?.link.active === false &&
      revokedReview.link.projectToken === null &&
      revokedReview.history[0]?.eventType === "REVOKED",
  );

  const revokeAgain = await revokeJobProjectLink(prisma, ownerA, { jobId: jobA.id });
  check(
    "Second revoke is unchanged and keeps history",
    revokeAgain.unchanged === true &&
      JOB_PROJECT_LINK_ALREADY_REVOKED_MESSAGE.includes("already revoked"),
  );

  const reissued = await rotateJobProjectLink(prisma, ownerA, { jobId: jobA.id });
  check(
    "Rotate after revoke issues a new live link on the same job",
    reissued.jobId === jobA.id &&
      reissued.businessId === businessA.id &&
      (await isLiveProjectToken(prisma, reissued.projectToken)) === true &&
      (await isLiveProjectToken(prisma, tokenA)) === false &&
      (await isLiveProjectToken(prisma, rotated.projectToken)) === false,
  );
  check(
    "Outbound helper omits revoked tokens and returns the live token",
    (await liveOutboundProjectToken(prisma, tokenA)) === null &&
      (await liveOutboundProjectToken(prisma, rotated.projectToken)) === null &&
      (await liveOutboundProjectToken(prisma, burned)) === null &&
      (await liveOutboundProjectToken(prisma, reissued.projectToken)) ===
        reissued.projectToken,
  );

  console.log("\nPRESERVE — historical records and counts stay");
  const invoicesAfter = await countBusinessInvoices(prisma, businessA.id);
  const jobsAfter = await countBusinessJobs(prisma, businessA.id);
  const paymentsAfter = await countBusinessPayments(prisma, businessA.id);
  const commsAfter = await countBusinessCommunications(prisma, businessA.id);
  const historicalMessage = await prisma.customerCommunication.findFirst({
    where: { relatedId: jobA.id, relatedType: "JOB" },
  });
  const historicalInvoice = await prisma.invoice.findFirst({
    where: { jobId: jobA.id, businessId: businessA.id },
  });
  check(
    "Rotate/revoke did not add invoices, jobs, payments, or messages",
    invoicesAfter === invoicesBefore &&
      jobsAfter === jobsBefore &&
      paymentsAfter === paymentsBefore &&
      commsAfter === commsBefore,
  );
  check(
    "Historical invoice and communication rows still belong to the same job",
    historicalInvoice?.id != null &&
      historicalMessage?.bodySnapshot.includes(`/p/${tokenA}`) === true,
  );

  console.log("\nCONCURRENCY — parallel rotates share the FOR UPDATE job lock");
  const raceJob = await createJob(businessA.id, { token: `race-${suffix}` });
  const raceStartToken = raceJob.projectToken;
  const rotateBarrier = createWriteBarrier(8, 8000);
  jobProjectLinkTestHooks.beforeJobLock = async ({ kind }) => {
    if (kind === "rotate") await rotateBarrier.arriveAndWait();
  };
  const raceClients = Array.from({ length: 8 }, () => session.createClient());
  try {
    const raceResults = await Promise.allSettled(
      raceClients.map((client) =>
        rotateJobProjectLink(client, ownerA, { jobId: raceJob.id }),
      ),
    );
    const fulfilled = raceResults.filter((result) => result.status === "fulfilled");
    const winners = fulfilled.filter(
      (result) => result.value.previousToken === raceStartToken,
    );
    const conflicts = raceResults.filter(
      (result) =>
        result.status === "rejected" &&
        jobProjectLinkErrorMessage(result.reason, "") === JOB_PROJECT_LINK_CONFLICT_MESSAGE,
    );
    const rotateEvents = await prisma.jobProjectLinkEvent.count({
      where: { jobId: raceJob.id, eventType: "ROTATED" },
    });
    const liveJob = await prisma.job.findUnique({
      where: { id: raceJob.id },
      select: { projectToken: true, businessId: true },
    });
    check(
      "Exactly one rotator wins the original token",
      winners.length === 1 && liveJob?.businessId === businessA.id,
    );
    check(
      "Losing rotators conflict or serialize onto a later token",
      fulfilled.length + conflicts.length === 8 && rotateEvents >= 1,
    );
    check(
      "The original race token is dead after the wave",
      (await isLiveProjectToken(prisma, raceStartToken)) === false &&
        (await isLiveProjectToken(prisma, liveJob.projectToken)) === true,
    );
  } finally {
    jobProjectLinkTestHooks.beforeJobLock = undefined;
    await Promise.all(raceClients.map((client) => client.$disconnect()));
  }

  console.log("\nCUSTOMER PATHS — old tokens are refused beyond additional-work");
  const callbackJob = await createJob(businessA.id, {
    status: "COMPLETED",
    token: `cb-${suffix}`,
  });
  const callbackFirst = await submitPortalJobCallback(prisma, {
    token: callbackJob.projectToken,
    description: "Please look at the completed repair.",
    preferredContact: "PHONE",
  });
  const callbackRotated = await rotateJobProjectLink(prisma, ownerA, {
    jobId: callbackJob.id,
  });
  const callbackOld = await submitPortalJobCallback(prisma, {
    token: callbackJob.projectToken,
    description: "Stale callback after rotate.",
    preferredContact: "EMAIL",
  });
  const callbackNew = await submitPortalJobCallback(prisma, {
    token: callbackRotated.projectToken,
    description: "Fresh callback on the new link.",
    preferredContact: "TEXT",
  });
  const callbackOldView = await loadPortalJobCallbackView(
    prisma,
    callbackJob.projectToken,
  );
  check(
    "Portal callback refuses the old token and accepts the new one",
    callbackFirst.ok === true &&
      callbackFirst.alreadyExists === false &&
      callbackOld.ok === false &&
      callbackOld.error === JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE &&
      callbackNew.ok === true &&
      callbackNew.alreadyExists === true &&
      callbackNew.jobId === callbackJob.id &&
      callbackOldView.status === "hidden",
  );

  const apptJob = await createJob(businessA.id, { token: `appt-${suffix}` });
  await prisma.job.update({
    where: { id: apptJob.id },
    data: {
      scheduledAt: new Date("2026-10-03T15:00:00.000Z"),
      scheduledDurationMinutes: 60,
      appointmentProposalId: 1,
      appointmentConfirmationStatus: "AWAITING_CUSTOMER",
    },
  });
  const apptRotated = await rotateJobProjectLink(prisma, ownerA, {
    jobId: apptJob.id,
  });
  const oldApptJob = await findLiveJobByProjectToken(prisma, apptJob.projectToken, {
    id: true,
  });
  const liveApptJob = await findLiveJobByProjectToken(
    prisma,
    apptRotated.projectToken,
    { id: true },
  );
  const staleApptWrite = await prisma.job.updateMany({
    where: {
      id: apptJob.id,
      projectToken: apptJob.projectToken,
      appointmentProposalId: 1,
      appointmentConfirmationStatus: {
        in: ["NONE", "AWAITING_CUSTOMER", "DIFFERENT_TIME_REQUESTED"],
      },
    },
    data: { appointmentConfirmationStatus: "CONFIRMED" },
  });
  const apptAfterOld = await prisma.job.findUnique({
    where: { id: apptJob.id },
    select: { appointmentConfirmationStatus: true, projectToken: true },
  });
  check(
    "Appointment confirm refuses the old token and does not write",
    oldApptJob === null &&
      liveApptJob?.id === apptJob.id &&
      staleApptWrite.count === 0 &&
      apptAfterOld?.appointmentConfirmationStatus === "AWAITING_CUSTOMER" &&
      apptAfterOld.projectToken === apptRotated.projectToken,
  );

  const changeJob = await createJob(businessA.id, { token: `co-${suffix}` });
  const sentChange = await prisma.changeOrder.create({
    data: {
      businessId: businessA.id,
      jobId: changeJob.id,
      title: "Extra outlet",
      status: "SENT",
      total: 40,
      sentAt: new Date(),
    },
  });
  const changeRotated = await rotateJobProjectLink(prisma, ownerA, {
    jobId: changeJob.id,
  });
  const oldChangeJob = await findLiveJobByProjectToken(
    prisma,
    changeJob.projectToken,
    { id: true },
  );
  const liveChangeJob = await findLiveJobByProjectToken(
    prisma,
    changeRotated.projectToken,
    { id: true },
  );
  const staleChangeWrite = oldChangeJob
    ? await prisma.changeOrder.updateMany({
        where: { id: sentChange.id, jobId: oldChangeJob.id, status: "SENT" },
        data: { status: "APPROVED", approvedAt: new Date() },
      })
    : { count: 0 };
  const changeAfterOld = await prisma.changeOrder.findUnique({
    where: { id: sentChange.id },
    select: { status: true },
  });
  check(
    "Change-order approve refuses the old token and does not write",
    oldChangeJob === null &&
      liveChangeJob?.id === changeJob.id &&
      staleChangeWrite.count === 0 &&
      changeAfterOld?.status === "SENT" &&
      (await isLiveProjectToken(prisma, changeRotated.projectToken)) === true,
  );

  console.log("\nBARRIER — in-flight old-token callback cannot land after rotate commits");
  const barrierJob = await createJob(businessA.id, {
    status: "COMPLETED",
    token: `barrier-${suffix}`,
  });
  const barrierOldToken = barrierJob.projectToken;
  const rotateClient = session.createClient();
  const callbackClient = session.createClient();
  jobProjectLinkTestHooks.afterJobLock = async ({ kind }) => {
    if (kind === "rotate") {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  };
  try {
    const rotateStarted = Date.now();
    const rotatePromise = rotateJobProjectLink(rotateClient, ownerA, {
      jobId: barrierJob.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const callbackPromise = submitPortalJobCallback(callbackClient, {
      token: barrierOldToken,
      description: "In-flight callback after rotate has the job lock.",
      preferredContact: "PHONE",
    });
    const [rotatedBarrier, callbackBarrier] = await Promise.all([
      rotatePromise,
      callbackPromise,
    ]);
    const barrierCount = await prisma.jobCallback.count({
      where: { jobId: barrierJob.id },
    });
    check(
      "Old-token callback that locked after rotate is refused (afterJobLock proof)",
      rotatedBarrier.previousToken === barrierOldToken &&
        callbackBarrier.ok === false &&
        callbackBarrier.error === JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE &&
        barrierCount === 0 &&
        Date.now() - rotateStarted >= 1500 &&
        (await assertLiveLockedProjectToken(prisma, {
          jobId: barrierJob.id,
          businessId: businessA.id,
          token: barrierOldToken,
        })) === false,
    );
  } finally {
    jobProjectLinkTestHooks.afterJobLock = undefined;
    await Promise.all([rotateClient.$disconnect(), callbackClient.$disconnect()]);
  }

  console.log("\nMISSING SCHEMA — writes fail closed; current Job.projectToken still resolves");
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "JobProjectLinkEvent" CASCADE`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "JobProjectLink" CASCADE`);
  const missingTables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('JobProjectLink', 'JobProjectLinkEvent')
  `;
  check("Project-link tables are absent after the drop", missingTables.length === 0);

  await expectThrow(
    "Rotate fails closed when tables are missing",
    () => rotateJobProjectLink(prisma, ownerA, { jobId: jobA2.id }),
    (error) =>
      jobProjectLinkErrorMessage(error, "") === JOB_PROJECT_LINK_UNAVAILABLE_MESSAGE,
  );
  check(
    "Current Job.projectToken still resolves when status tables are missing",
    (await isLiveProjectToken(prisma, tokenA2)) === true &&
      (await findLiveJobByProjectToken(prisma, tokenA2, { id: true }))?.id === jobA2.id,
  );

  const degradeCompleted = await createJob(businessA.id, {
    status: "COMPLETED",
    token: `degrade-cb-${suffix}`,
  });
  const degradeCallback = await submitPortalJobCallback(prisma, {
    token: degradeCompleted.projectToken,
    description: "Callback after the project-link tables were dropped.",
    preferredContact: "PHONE",
  });
  const degradeTx = await prisma.$transaction(async (tx) => {
    return findLiveJobByProjectToken(tx, tokenA2, { id: true });
  });
  check(
    "submitPortalJobCallback degrades inside a transaction when tables are missing",
    degradeCallback.ok === true &&
      degradeCallback.jobId === degradeCompleted.id &&
      degradeCallback.alreadyExists === false,
  );
  check(
    "Generic $transaction using findLive degrades when tables are missing",
    degradeTx?.id === jobA2.id,
  );
} catch (error) {
  failed += 1;
  console.error("FAIL - project-link disposable database run");
  console.error(error);
} finally {
  jobProjectLinkTestHooks.beforeJobLock = undefined;
  jobProjectLinkTestHooks.afterJobLock = undefined;
  portalJobCallbackTestHooks.afterJobLock = undefined;
  if (session) {
    await session.cleanup();
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

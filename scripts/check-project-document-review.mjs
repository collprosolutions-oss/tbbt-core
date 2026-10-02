/**
 * OWNER review of private customer project documents.
 *
 * Dedicated local disposable database (name prefix tbbt_pdoc_review).
 *
 * Proves OWNER authorization, project-token and tenant isolation,
 * private download rules after a review, idempotent retries, and
 * claimed decision races. Review never publishes, invoices, or messages.
 *
 * Run with:
 *   npm run test:project-document-review
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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
  console.error("Failed to generate Prisma client for project-document-review checks.");
  process.exit(generateEarly.status ?? 1);
}

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const {
  MemoryStorageProvider,
  PROJECT_DOCUMENT_MAX_COUNT,
  PRIVATE_DOWNLOAD_URL_TTL_SECONDS,
  authorizePrivateStoredAssetDownload,
  authorizeProjectTokenDocument,
  countActiveProjectDocuments,
  listProjectDocumentsForOwnerReview,
  listProjectDocumentsForPortal,
  privateAssetPath,
  putProjectTokenDocumentFromBytes,
  servePrivateStoredAsset,
  servePublicStoredAsset,
} = await import("@/lib/business-storage/index");
const {
  PROJECT_DOCUMENT_REVIEW_CONFLICT_MESSAGE,
  PROJECT_DOCUMENT_REVIEW_NEEDS_REPLACEMENT_LABEL,
  PROJECT_DOCUMENT_REVIEW_NOT_PRIVATE_MESSAGE,
  PROJECT_DOCUMENT_REVIEW_OWNER_ONLY_MESSAGE,
  PROJECT_DOCUMENT_REVIEW_RECORDED_MESSAGE,
  PROJECT_DOCUMENT_REVIEW_REVIEWED_LABEL,
  PROJECT_DOCUMENT_REVIEW_STATUS_REQUIRED_MESSAGE,
  PROJECT_DOCUMENT_REVIEW_UNAVAILABLE_MESSAGE,
  PROJECT_DOCUMENT_REVIEW_UNCHANGED_MESSAGE,
  PROJECT_DOCUMENT_REVIEW_UNKNOWN_MESSAGE,
  missingProjectDocumentReviewSchema,
  parseProjectDocumentReviewReason,
  projectDocumentReviewWriteAllowed,
  recordedProjectDocumentReviewLabel,
} = await import("@/lib/project-document-review");
const {
  projectDocumentReviewErrorMessage,
  projectDocumentReviewTestHooks,
  recordProjectDocumentReview,
} = await import("@/lib/project-document-review-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the project-document-review check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "project-document-review dedicated local database");

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

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForTestDbLockWaiter(admin, testDbName, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const waiting = await admin.$queryRaw`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = ${testDbName}
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `;
    if (waiting.length > 0) return waiting;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${ms}ms waiting for wait_event_type=Lock in ${testDbName}`);
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: `${role.toLowerCase()}@example.com`, name: role },
      business: { id: businessId, name: "Project Doc Review Co" },
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
  "src/lib/project-document-review.ts",
  "src/lib/project-document-review-ops.ts",
  "src/app/actions/project-document-review.ts",
  "src/components/jobs/project-document-review-list.tsx",
  "src/components/jobs/project-document-review-form.tsx",
  "src/components/portal/project-document-upload.tsx",
];
const featureSrc = featureFiles.map(read).join("\n");
const opsSrc = read("src/lib/project-document-review-ops.ts");
const actionSrc = read("src/app/actions/project-document-review.ts");
const formSrc = read("src/components/jobs/project-document-review-form.tsx");
const listSrc = read("src/components/jobs/project-document-review-list.tsx");
const portalComponentSrc = read("src/components/portal/project-document-upload.tsx");
const publicActionSrc = read("src/app/actions/public-project-documents.ts");
const pageSrc = read("src/app/(app)/jobs/[jobId]/page.tsx");
const portalSrc = read("src/app/p/[token]/page.tsx");
const navSrc = read("src/components/record-nav.tsx");
const schemaSrc = read("prisma/schema.prisma");
const migrationSrc = read(
  "prisma/migrations/20261001200000_project_document_review/migration.sql",
);

console.log("\nSTATIC — OWNER-only, private, no message/invoice/publish");
check(
  "OWNER-only write gate",
  projectDocumentReviewWriteAllowed("OWNER") === true &&
    projectDocumentReviewWriteAllowed("ADMIN") === false &&
    projectDocumentReviewWriteAllowed("MEMBER") === false &&
    opsSrc.includes("requireBusinessRole(access, \"OWNER\")") &&
    opsSrc.includes("PROJECT_DOCUMENT_REVIEW_OWNER_ONLY_MESSAGE"),
);
check(
  "Reason is clipped to 200 characters",
  parseProjectDocumentReviewReason("  " ) === null &&
    parseProjectDocumentReviewReason("x".repeat(250))?.length === 200 &&
    recordedProjectDocumentReviewLabel("REVIEWED") ===
      PROJECT_DOCUMENT_REVIEW_REVIEWED_LABEL &&
    recordedProjectDocumentReviewLabel("NEEDS_REPLACEMENT") ===
      PROJECT_DOCUMENT_REVIEW_NEEDS_REPLACEMENT_LABEL,
);
check(
  "Write path does not publish, invoice, or message",
  !opsSrc.includes("invoice.create") &&
    !opsSrc.includes("persistDraftInvoice") &&
    !opsSrc.includes("payment.create") &&
    !opsSrc.includes("notifyCustomer") &&
    !opsSrc.includes("sendCustomer") &&
    !opsSrc.includes("emitAndProcessBusinessEvent") &&
    !opsSrc.includes("storedAsset.update") &&
    !opsSrc.includes("visibility: \"PUBLIC\"") &&
    !opsSrc.includes('publicPath: "') &&
    !actionSrc.includes("invoice.create") &&
    !actionSrc.includes("notifyCustomer") &&
    !publicActionSrc.includes("recordProjectDocumentReview") &&
    PROJECT_DOCUMENT_REVIEW_RECORDED_MESSAGE.includes("stays private") &&
    PROJECT_DOCUMENT_REVIEW_RECORDED_MESSAGE.includes("No customer message") &&
    formSrc.includes("does not publish") &&
    formSrc.includes("attach it to an invoice") &&
    formSrc.includes("send a customer message"),
);
check(
  "Additive ProjectDocumentReview table; StoredAsset and Job columns untouched",
  schemaSrc.includes("model ProjectDocumentReview") &&
    schemaSrc.includes("Recording Reviewed or Needs replacement does not publish") &&
    migrationSrc.includes('CREATE TABLE IF NOT EXISTS "ProjectDocumentReview"') &&
    !migrationSrc.includes('ALTER TABLE "Job"') &&
    !migrationSrc.includes('ALTER TABLE "StoredAsset"') &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSrc),
);
check(
  "Decision claims the StoredAsset lock then updateMany / unique create",
  opsSrc.includes("FOR UPDATE") &&
    opsSrc.includes("projectDocumentReview.updateMany") &&
    opsSrc.includes("expectedStatus") &&
    opsSrc.includes("PROJECT_DOCUMENT_REVIEW_CONFLICT_MESSAGE") &&
    opsSrc.includes("afterAssetLock"),
);
check(
  "Loaders degrade on missing review table; writes fail closed",
  missingProjectDocumentReviewSchema({ code: "P2021" }) &&
    missingProjectDocumentReviewSchema({ code: "P2022" }) &&
    !missingProjectDocumentReviewSchema({ code: "P2002" }) &&
    projectDocumentReviewErrorMessage({ code: "P2021" }, "fallback") ===
      PROJECT_DOCUMENT_REVIEW_UNAVAILABLE_MESSAGE &&
    read("src/lib/business-storage/project-documents.ts").includes(
      "to_regclass('\"ProjectDocumentReview\"')",
    ),
);
check(
  "Work Order hosts the OWNER form; portal shows recorded status; no global nav change",
  pageSrc.includes("ProjectDocumentReviewList") &&
    pageSrc.includes("canDecide={access.workspace.role === \"OWNER\"}") &&
    listSrc.includes("ProjectDocumentReviewForm") &&
    formSrc.includes("expectedStatus") &&
    formSrc.includes('value="REVIEWED"') &&
    formSrc.includes('value="NEEDS_REPLACEMENT"') &&
    portalSrc.includes("ProjectDocumentUpload") &&
    portalComponentSrc.includes("reviewStatusLabel") &&
    portalComponentSrc.includes("NEEDS_REPLACEMENT") &&
    !navSrc.toLowerCase().includes("project document review") &&
    !featureSrc.includes("dangerouslySetInnerHTML"),
);

const pdfBytes = Buffer.from("%PDF-1.4 review-doc\n%%EOF\n");

let session;
try {
  session = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_pdoc_review",
    setProcessEnv: true,
  });
  const prisma = session.prisma;
  check(
    "Dedicated local disposable database opened",
    Boolean(session.testDbName?.startsWith("tbbt_pdoc_review_")),
  );

  const suffix = randomUUID().slice(0, 8);
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-pdr-${suffix}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir", email: `admin-pdr-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-pdr-${suffix}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-pdr-${suffix}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Review Docs", slug: `alpha-pdr-${suffix}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Review Docs", slug: `beta-pdr-${suffix}`, tradeCode: "HANDYMAN" },
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
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id, ownerUser.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id, adminUser.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id, memberUser.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id, betaUser.id);

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Cara", phone: "555-0100" },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
    },
  });
  const siblingJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      projectToken: randomUUID(),
      status: "IN_PROGRESS",
    },
  });
  const jobB = await prisma.job.create({
    data: {
      businessId: businessB.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
    },
  });
  const raceJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
    },
  });

  const provider = new MemoryStorageProvider();
  const deps = {
    db: prisma,
    provider,
    bucketName: "tbbt-pdoc-review-test",
    defaultLimitBytes: 50 * 1024 * 1024,
  };

  async function snapshot(jobId) {
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true, scheduledAt: true, assignedMembershipId: true },
    });
    const invoices = await prisma.invoice.count({ where: { jobId } });
    const messages = await prisma.customerCommunication.count({
      where: { relatedType: "JOB", relatedId: jobId },
    });
    return { ...job, invoices, messages };
  }

  const saved = await putProjectTokenDocumentFromBytes(deps, jobA.projectToken, {
    originalFilename: "permit.pdf",
    mimeType: "application/pdf",
    body: pdfBytes,
  });
  const siblingDoc = await putProjectTokenDocumentFromBytes(
    deps,
    siblingJob.projectToken,
    {
      originalFilename: "sibling.pdf",
      mimeType: "application/pdf",
      body: pdfBytes,
    },
  );
  const savedB = await putProjectTokenDocumentFromBytes(deps, jobB.projectToken, {
    originalFilename: "beta.pdf",
    mimeType: "application/pdf",
    body: pdfBytes,
  });
  const raceDoc = await putProjectTokenDocumentFromBytes(deps, raceJob.projectToken, {
    originalFilename: "race.pdf",
    mimeType: "application/pdf",
    body: pdfBytes,
  });
  const before = await snapshot(jobA.id);

  console.log("\nDB — Authorization and isolation");
  await expectThrow(
    "ADMIN cannot record a review",
    () =>
      recordProjectDocumentReview(prisma, adminA, {
        jobId: jobA.id,
        storedAssetId: saved.id,
        status: "REVIEWED",
        expectedStatus: "",
      }),
    (error) =>
      error instanceof ForbiddenError &&
      error.message === PROJECT_DOCUMENT_REVIEW_OWNER_ONLY_MESSAGE,
  );
  await expectThrow(
    "MEMBER cannot record a review",
    () =>
      recordProjectDocumentReview(prisma, memberA, {
        jobId: jobA.id,
        storedAssetId: saved.id,
        status: "REVIEWED",
        expectedStatus: "",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectThrow(
    "Foreign OWNER cannot review tenant A's document",
    () =>
      recordProjectDocumentReview(prisma, ownerB, {
        jobId: jobA.id,
        storedAssetId: saved.id,
        status: "REVIEWED",
        expectedStatus: "",
      }),
    (error) =>
      error instanceof Error &&
      (error.message === PROJECT_DOCUMENT_REVIEW_UNKNOWN_MESSAGE ||
        error.message.includes("authorized business")),
  );
  await expectThrow(
    "Sibling job id cannot claim this project's document",
    () =>
      recordProjectDocumentReview(prisma, ownerA, {
        jobId: siblingJob.id,
        storedAssetId: saved.id,
        status: "REVIEWED",
        expectedStatus: "",
      }),
    (error) => error.message === PROJECT_DOCUMENT_REVIEW_UNKNOWN_MESSAGE,
  );
  await expectThrow(
    "Unknown status is refused",
    () =>
      recordProjectDocumentReview(prisma, ownerA, {
        jobId: jobA.id,
        storedAssetId: saved.id,
        status: "APPROVED",
        expectedStatus: "",
      }),
    (error) => error.message === PROJECT_DOCUMENT_REVIEW_STATUS_REQUIRED_MESSAGE,
  );

  const first = await recordProjectDocumentReview(prisma, ownerA, {
    jobId: jobA.id,
    storedAssetId: saved.id,
    status: "REVIEWED",
    reason: "Looks complete",
    expectedStatus: "",
  });
  check(
    "OWNER can mark a private document Reviewed",
    first.unchanged === false &&
      first.review.status === "REVIEWED" &&
      first.review.reason === "Looks complete" &&
      first.review.statusLabel === PROJECT_DOCUMENT_REVIEW_REVIEWED_LABEL,
  );

  const retry = await recordProjectDocumentReview(prisma, ownerA, {
    jobId: jobA.id,
    storedAssetId: saved.id,
    status: "REVIEWED",
    reason: "Looks complete",
    expectedStatus: "",
  });
  check(
    "Retry of the same decision is unchanged",
    retry.unchanged === true && retry.review.status === "REVIEWED",
  );

  await expectThrow(
    "A different first-decision expectedStatus conflicts after a review exists",
    () =>
      recordProjectDocumentReview(prisma, ownerA, {
        jobId: jobA.id,
        storedAssetId: saved.id,
        status: "NEEDS_REPLACEMENT",
        reason: "Blurry",
        expectedStatus: "",
      }),
    (error) => error.message === PROJECT_DOCUMENT_REVIEW_CONFLICT_MESSAGE,
  );

  const changed = await recordProjectDocumentReview(prisma, ownerA, {
    jobId: jobA.id,
    storedAssetId: saved.id,
    status: "NEEDS_REPLACEMENT",
    reason: "Please rescan",
    expectedStatus: "REVIEWED",
  });
  check(
    "OWNER can change the decision when the expected status matches",
    changed.unchanged === false &&
      changed.review.status === "NEEDS_REPLACEMENT" &&
      changed.review.reason === "Please rescan",
  );

  const after = await snapshot(jobA.id);
  const stillPrivate = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: saved.id },
  });
  check(
    "Review does not publish, invoice, message, or change the Job",
    stillPrivate.visibility === "PRIVATE" &&
      stillPrivate.publicPath == null &&
      stillPrivate.status === "READY" &&
      stillPrivate.purpose === "project-portal-document" &&
      after.status === before.status &&
      after.invoices === 0 &&
      after.messages === 0,
  );

  const portalList = await listProjectDocumentsForPortal(prisma, jobA.projectToken);
  check(
    "Customer portal shows the recorded status and reason without a download URL",
    portalList.length === 1 &&
      portalList[0].reviewStatus === "NEEDS_REPLACEMENT" &&
      portalList[0].reviewStatusLabel === PROJECT_DOCUMENT_REVIEW_NEEDS_REPLACEMENT_LABEL &&
      portalList[0].reviewReason === "Please rescan" &&
      !("reviewHref" in portalList[0]),
  );
  const emptyPortal = await listProjectDocumentsForPortal(prisma, randomUUID());
  const foreignPortal = await listProjectDocumentsForPortal(prisma, jobB.projectToken);
  check(
    "Unknown and foreign tokens do not see tenant A's review",
    emptyPortal.length === 0 &&
      foreignPortal.length === 1 &&
      foreignPortal[0].id === savedB.id &&
      foreignPortal[0].reviewStatus === null,
  );

  const ownerList = await listProjectDocumentsForOwnerReview(prisma, {
    businessId: businessA.id,
    jobId: jobA.id,
  });
  const foreignOwnerList = await listProjectDocumentsForOwnerReview(prisma, {
    businessId: businessB.id,
    jobId: jobA.id,
  });
  const siblingOwnerList = await listProjectDocumentsForOwnerReview(prisma, {
    businessId: businessA.id,
    jobId: siblingJob.id,
  });
  check(
    "Same-business review list includes status and the private download path",
    ownerList.length === 1 &&
      ownerList[0].id === saved.id &&
      ownerList[0].reviewStatus === "NEEDS_REPLACEMENT" &&
      ownerList[0].reviewHref === privateAssetPath(saved.id),
  );
  check(
    "Foreign business and sibling job review lists stay isolated",
    foreignOwnerList.length === 0 &&
      siblingOwnerList.length === 1 &&
      siblingOwnerList[0].id === siblingDoc.id &&
      siblingOwnerList[0].reviewStatus === null,
  );

  console.log("\nDB — Private download rules stay unchanged after review");
  const ownerViewer = { role: "OWNER", membershipId: ownerMem.id };
  const adminViewer = { role: "ADMIN", membershipId: adminMem.id };
  const memberViewer = { role: "MEMBER", membershipId: memberMem.id };
  const betaViewer = { role: "OWNER", membershipId: betaMem.id };
  const ownerRead = await authorizePrivateStoredAssetDownload(
    prisma,
    saved.id,
    businessA.id,
    { provider, viewer: ownerViewer },
  );
  const adminRead = await authorizePrivateStoredAssetDownload(
    prisma,
    saved.id,
    businessA.id,
    { provider, viewer: adminViewer },
  );
  const memberRead = await authorizePrivateStoredAssetDownload(
    prisma,
    saved.id,
    businessA.id,
    { provider, viewer: memberViewer },
  );
  const betaRead = await authorizePrivateStoredAssetDownload(
    prisma,
    saved.id,
    businessB.id,
    { provider, viewer: betaViewer },
  );
  const ownerBytes = await servePrivateStoredAsset(prisma, saved.id, businessA.id, {
    provider,
    viewer: ownerViewer,
  });
  const publicLeak = await servePublicStoredAsset(prisma, saved.id, { provider });
  check(
    "Same-business OWNER and ADMIN can still download the private file",
    ownerRead.ok === true &&
      ownerRead.status === 302 &&
      ownerRead.expiresInSeconds === PRIVATE_DOWNLOAD_URL_TTL_SECONDS &&
      adminRead.ok === true &&
      ownerBytes.ok === true &&
      ownerBytes.contentType === "application/pdf",
  );
  check(
    "MEMBER, foreign OWNER, and the public route still cannot read the file",
    memberRead.ok === false &&
      memberRead.status === 404 &&
      betaRead.ok === false &&
      publicLeak.ok === false,
  );

  console.log("\nDB — Replacement uses the existing upload rules");
  for (let i = 0; i < PROJECT_DOCUMENT_MAX_COUNT - 1; i += 1) {
    await putProjectTokenDocumentFromBytes(deps, jobA.projectToken, {
      originalFilename: `extra-${i}.pdf`,
      mimeType: "application/pdf",
      body: pdfBytes,
    });
  }
  const fullReady = await prisma.storedAsset.count({
    where: {
      jobId: jobA.id,
      purpose: "project-portal-document",
      status: "READY",
    },
  });
  const activeNeedingReplacement = await countActiveProjectDocuments(prisma, {
    businessId: businessA.id,
    jobId: jobA.id,
  });
  check(
    "A Needs replacement document frees one existing upload slot",
    fullReady === PROJECT_DOCUMENT_MAX_COUNT &&
      activeNeedingReplacement === PROJECT_DOCUMENT_MAX_COUNT - 1,
  );
  const replacement = await putProjectTokenDocumentFromBytes(deps, jobA.projectToken, {
    originalFilename: "permit-rescan.pdf",
    mimeType: "application/pdf",
    body: pdfBytes,
  });
  const afterReplacement = await snapshot(jobA.id);
  const originalAfterReplace = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: saved.id },
  });
  const portalAfterReplace = await listProjectDocumentsForPortal(
    prisma,
    jobA.projectToken,
  );
  check(
    "Replacement upload stays private and does not rewrite the original file",
    replacement.status === "READY" &&
      replacement.visibility === "PRIVATE" &&
      replacement.publicPath == null &&
      replacement.id !== saved.id &&
      originalAfterReplace.visibility === "PRIVATE" &&
      originalAfterReplace.publicPath == null &&
      afterReplacement.invoices === 0 &&
      afterReplacement.messages === 0 &&
      portalAfterReplace.some(
        (row) =>
          row.id === saved.id && row.reviewStatus === "NEEDS_REPLACEMENT",
      ) &&
      portalAfterReplace.some(
        (row) => row.id === replacement.id && row.reviewStatus === null,
      ),
  );

  console.log("\nDB — Concurrent first decisions cannot overwrite each other");
  const raceClientA = session.createClient();
  const raceClientB = session.createClient();
  const raceAdmin = session.createClient();
  let hookCalls = 0;
  let releaseHook = () => undefined;
  const hookHeld = new Promise((resolve) => {
    releaseHook = resolve;
  });
  let signalHookArrived = () => undefined;
  const hookArrived = new Promise((resolve) => {
    signalHookArrived = resolve;
  });
  projectDocumentReviewTestHooks.afterAssetLock = async () => {
    hookCalls += 1;
    signalHookArrived();
    await hookHeld;
  };
  let promiseA;
  let promiseB;
  try {
    let barrierError;
    try {
      promiseA = recordProjectDocumentReview(raceClientA, ownerA, {
        jobId: raceJob.id,
        storedAssetId: raceDoc.id,
        status: "REVIEWED",
        reason: "A",
        expectedStatus: "",
      });
      await withTimeout(hookArrived, 4000, "contender A afterAssetLock");
      promiseB = recordProjectDocumentReview(raceClientB, ownerA, {
        jobId: raceJob.id,
        storedAssetId: raceDoc.id,
        status: "NEEDS_REPLACEMENT",
        reason: "B",
        expectedStatus: "",
      });
      await waitForTestDbLockWaiter(raceAdmin, session.testDbName, 4000);
      check("afterAssetLock ran exactly once while B waited on Lock", hookCalls === 1);
    } catch (error) {
      barrierError = error;
    } finally {
      releaseHook();
    }
    const settled = await withTimeout(
      Promise.allSettled([promiseA, promiseB].filter(Boolean)),
      4000,
      "race reviews finish",
    );
    if (barrierError) throw barrierError;
    const raceOk = settled.filter((result) => result.status === "fulfilled");
    const raceDenied = settled.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof Error &&
        result.reason.message === PROJECT_DOCUMENT_REVIEW_CONFLICT_MESSAGE,
    );
    const stored = await prisma.projectDocumentReview.findFirst({
      where: { storedAssetId: raceDoc.id, businessId: businessA.id },
    });
    check(
      "Exactly one first decision is recorded and the loser hits the claim conflict",
      raceOk.length === 1 &&
        raceDenied.length === 1 &&
        stored?.status === "REVIEWED" &&
        stored?.reason === "A",
    );
  } finally {
    projectDocumentReviewTestHooks.afterAssetLock = undefined;
  }

  await expectThrow(
    "Expense-purpose job file cannot be reviewed as a project document",
    async () => {
      const account = await prisma.businessStorageAccount.findUniqueOrThrow({
        where: { businessId: businessA.id },
      });
      const receipt = await prisma.storedAsset.create({
        data: {
          businessId: businessA.id,
          storageAccountId: account.id,
          jobId: jobA.id,
          category: "ATTACHMENT",
          purpose: "expense-receipt",
          originalFilename: "receipt.pdf",
          storageKey: `businesses/${businessA.id}/documents/receipt-${randomUUID()}.pdf`,
          mimeType: "application/pdf",
          fileSizeBytes: pdfBytes.byteLength,
          visibility: "PRIVATE",
          status: "READY",
        },
      });
      await recordProjectDocumentReview(prisma, ownerA, {
        jobId: jobA.id,
        storedAssetId: receipt.id,
        status: "REVIEWED",
        expectedStatus: "",
      });
    },
    (error) => error.message === PROJECT_DOCUMENT_REVIEW_NOT_PRIVATE_MESSAGE,
  );

  console.log("\nDB — Missing review table degrades lists and fails writes closed");
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "ProjectDocumentReview" CASCADE`);
  const degradedPortal = await listProjectDocumentsForPortal(prisma, jobA.projectToken);
  const degradedCount = await countActiveProjectDocuments(prisma, {
    businessId: businessA.id,
    jobId: jobA.id,
  });
  check(
    "Lists and counts still work when ProjectDocumentReview is absent",
    degradedPortal.every((row) => row.reviewStatus === null) &&
      degradedCount === PROJECT_DOCUMENT_MAX_COUNT + 1,
  );
  const authorizedWithoutTable = await authorizeProjectTokenDocument(
    deps,
    siblingJob.projectToken,
    {
      originalFilename: "preview-missing-table.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: pdfBytes.byteLength,
    },
  );
  check(
    "Authorize beforeCreate still authorizes when ProjectDocumentReview is absent",
    authorizedWithoutTable.asset.status === "PENDING" &&
      authorizedWithoutTable.asset.visibility === "PRIVATE" &&
      authorizedWithoutTable.asset.jobId === siblingJob.id &&
      authorizedWithoutTable.asset.publicPath == null &&
      authorizedWithoutTable.upload.method === "PUT",
  );
  await expectThrow(
    "Write fails closed when the review table is missing",
    () =>
      recordProjectDocumentReview(prisma, ownerA, {
        jobId: siblingJob.id,
        storedAssetId: siblingDoc.id,
        status: "REVIEWED",
        expectedStatus: "",
      }),
    (error) => error.message === PROJECT_DOCUMENT_REVIEW_UNAVAILABLE_MESSAGE,
  );
} catch (error) {
  console.error(error);
  failed += 1;
} finally {
  if (session) await session.cleanup();
}

const mutationChild = process.argv.includes("--mutation");
if (!mutationChild) {
  console.log("\nMUTATION — disable the to_regclass probe and require authorize to fail");
  const target = join(root, "src/lib/business-storage/project-documents.ts");
  const original = readFileSync(target, "utf8");
  const find = "  if (!probe[0]?.present) return [];";
  if (!original.includes(find) || !original.includes("to_regclass")) {
    check("mutation missing-table-probe found its target", false);
  } else {
    writeFileSync(target, original.replace(find, "  if (false && !probe[0]?.present) return [];"));
    try {
      const child = spawnSync(
        process.execPath,
        ["--experimental-strip-types", fileURLToPath(import.meta.url), "--mutation"],
        {
          encoding: "utf8",
          env: { ...process.env },
          timeout: 180_000,
        },
      );
      check(
        "mutation missing-table-probe makes dropped-table authorize fail",
        child.status !== 0,
      );
      if (child.status === 0) {
        console.error(child.stdout.slice(-3000));
        console.error(child.stderr.slice(-2000));
      }
    } finally {
      writeFileSync(target, original);
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} project-document-review check(s) failed.`);
  process.exit(1);
}

console.log(`\nAll project-document-review checks passed (${passed}).`);

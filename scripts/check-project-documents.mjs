/**
 * Project-token private documents: customer upload + OWNER/ADMIN review.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-project-documents.mjs
 *
 * Refuses any DATABASE_URL that is not localhost / 127.0.0.1 before
 * `prisma db push --accept-data-loss`. Uses MemoryStorageProvider only.
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  MemoryStorageProvider,
  PROJECT_DOCUMENT_MAX_BYTES,
  PROJECT_DOCUMENT_MAX_COUNT,
  PROJECT_DOCUMENT_MAX_FILENAME_LENGTH,
  PROJECT_DOCUMENT_PURPOSE,
  PROJECT_DOCUMENT_TYPE_MISMATCH,
  PRIVATE_DOWNLOAD_URL_TTL_SECONDS,
  StorageAccessError,
  StorageError,
  abortProjectTokenDocument,
  authorizeProjectTokenDocument,
  authorizePrivateStoredAssetDownload,
  finalizeProjectTokenDocument,
  inspectProjectDocumentUpload,
  listProjectDocumentsForOwnerReview,
  listProjectDocumentsForPortal,
  privateAssetPath,
  projectDocumentBytesMatchMime,
  putProjectTokenDocumentFromBytes,
  remainingProjectDocumentSlots,
  sanitizeProjectDocumentFilename,
  servePublicStoredAsset,
} = await import("@/lib/business-storage/index");
const { servePrivateStoredAsset } = await import(
  "@/lib/business-storage/private-serve"
);
const { authorizeManagedUpload, finalizeManagedUpload } = await import(
  "@/lib/business-storage/service"
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const parsed = new URL(baseUrl);
if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
  console.error(
    "Refusing to run: DATABASE_URL host must be localhost or 127.0.0.1 before db push --accept-data-loss.",
  );
  process.exit(1);
}

const testDbName = "tbbt_project_documents_test";
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for project document test database.");
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

async function expectThrow(label, fn, match) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, match(error));
  }
}

const pdfOk = inspectProjectDocumentUpload({
  type: "application/pdf",
  name: "permit.pdf",
  size: 1024,
});
const jpegOk = inspectProjectDocumentUpload({
  type: "image/jpeg",
  name: "scan.jpg",
  size: 1024,
});
const exeNo = inspectProjectDocumentUpload({
  type: "application/x-msdownload",
  name: "setup.exe",
  size: 1024,
});
const oversizeNo = inspectProjectDocumentUpload({
  type: "application/pdf",
  name: "huge.pdf",
  size: PROJECT_DOCUMENT_MAX_BYTES + 1,
});
const nanNo = inspectProjectDocumentUpload({
  type: "application/pdf",
  name: "nan.pdf",
  size: Number.NaN,
});
const floatNo = inspectProjectDocumentUpload({
  type: "application/pdf",
  name: "float.pdf",
  size: 12.5,
});
const dirtyName = inspectProjectDocumentUpload({
  type: "application/pdf",
  name: `bad\n\t${"x".repeat(250)}.pdf`,
  size: 1024,
});

console.log("\nPURE — MIME, size, filename, and magic gates");
check("PDF documents are accepted", pdfOk.ok === true && pdfOk.mimeType === "application/pdf");
check("JPEG scans are accepted", jpegOk.ok === true && jpegOk.mimeType === "image/jpeg");
check(
  "Unsupported MIME types are rejected",
  exeNo.ok === false && exeNo.error.includes("Unsupported file type"),
);
check(
  "Configured max upload size is enforced",
  oversizeNo.ok === false && oversizeNo.error.includes("too large"),
);
check(
  "NaN and non-integer sizes are refused",
  nanNo.ok === false && floatNo.ok === false,
);
check(
  "Filenames are clipped to 200 characters and stripped of control characters",
  dirtyName.ok === true &&
    dirtyName.fileName.length <= PROJECT_DOCUMENT_MAX_FILENAME_LENGTH &&
    !/[\u0000-\u001F\u007F]/.test(dirtyName.fileName) &&
    sanitizeProjectDocumentFilename("a\nb.pdf").includes("b.pdf"),
);
check(
  "Configured document ceiling is 8 MB and 5 files per project",
  PROJECT_DOCUMENT_MAX_BYTES === 8 * 1024 * 1024 &&
    PROJECT_DOCUMENT_MAX_COUNT === 5 &&
    remainingProjectDocumentSlots(0) === 5 &&
    remainingProjectDocumentSlots(5) === 0 &&
    remainingProjectDocumentSlots(16) === 0,
);
const pdfBytes = Buffer.from("%PDF-1.4 customer-doc\n%%EOF\n");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3, 4]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const webp = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([16, 0, 0, 0]),
  Buffer.from("WEBP"),
  Buffer.from([0, 0, 0, 0]),
]);
check("PDF magic matches application/pdf", projectDocumentBytesMatchMime("application/pdf", pdfBytes));
check("JPEG magic matches image/jpeg", projectDocumentBytesMatchMime("image/jpeg", jpeg));
check("PNG magic matches image/png", projectDocumentBytesMatchMime("image/png", png));
check("WEBP magic matches image/webp", projectDocumentBytesMatchMime("image/webp", webp));
check(
  "JPEG bytes do not match a PDF declaration",
  projectDocumentBytesMatchMime("application/pdf", jpeg) === false,
);

try {
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-pdoc-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-pdoc-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-pdoc-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-pdoc-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Project Docs", slug: `alpha-pdoc-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Project Docs", slug: `beta-pdoc-${randomUUID()}`, tradeCode: "HANDYMAN" },
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
  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Cara Canary", phone: "555-0100" },
  });
  const propertyA = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      addressLine1: "42 Canary Way",
      city: "Springfield",
      region: "IL",
      postalCode: "62704",
    },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
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
  const cancelledJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      projectToken: randomUUID(),
      status: "CANCELLED",
    },
  });
  const closedJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      projectToken: randomUUID(),
      status: "COMPLETED",
    },
  });
  const parallelJob = await prisma.job.create({
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
    bucketName: "tbbt-project-docs-test",
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

  const before = await snapshot(jobA.id);

  console.log("\nDB — Invalid / foreign / closed token refusal");
  await expectThrow(
    "Empty token is refused",
    () =>
      authorizeProjectTokenDocument(deps, "   ", {
        originalFilename: "permit.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: pdfBytes.byteLength,
      }),
    (error) => error instanceof StorageAccessError && error.message.includes("not available"),
  );
  await expectThrow(
    "Unknown token is refused",
    () =>
      authorizeProjectTokenDocument(deps, randomUUID(), {
        originalFilename: "permit.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: pdfBytes.byteLength,
      }),
    (error) => error instanceof StorageAccessError && error.message.includes("not available"),
  );
  await expectThrow(
    "Cancelled job token is refused",
    () =>
      authorizeProjectTokenDocument(deps, cancelledJob.projectToken, {
        originalFilename: "permit.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: pdfBytes.byteLength,
      }),
    (error) => error instanceof StorageAccessError && error.message.includes("closed"),
  );
  await expectThrow(
    "Completed/closed job token is refused",
    () =>
      authorizeProjectTokenDocument(deps, closedJob.projectToken, {
        originalFilename: "permit.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: pdfBytes.byteLength,
      }),
    (error) => error instanceof StorageAccessError && error.message.includes("closed"),
  );

  const authorized = await authorizeProjectTokenDocument(deps, jobA.projectToken, {
    originalFilename: "permit.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: pdfBytes.byteLength,
  });
  check(
    "Valid project token authorizes a private PENDING document for that job",
    authorized.asset.businessId === businessA.id &&
      authorized.asset.jobId === jobA.id &&
      authorized.asset.customerId === customerA.id &&
      authorized.asset.propertyId === propertyA.id &&
      authorized.asset.category === "DOCUMENT" &&
      authorized.asset.purpose === PROJECT_DOCUMENT_PURPOSE &&
      authorized.asset.visibility === "PRIVATE" &&
      authorized.asset.status === "PENDING" &&
      authorized.asset.publicPath == null &&
      authorized.asset.storageKey.startsWith(`businesses/${businessA.id}/documents/`) &&
      authorized.upload.method === "PUT",
  );
  check(
    "Presigned upload never exposes credentials or a public write path",
    !authorized.upload.url.includes("R2_SECRET") &&
      authorized.asset.publicPath == null,
  );

  await expectThrow(
    "Foreign token cannot finalize another project's pending document",
    () => finalizeProjectTokenDocument(deps, jobB.projectToken, authorized.asset.id),
    (error) => error instanceof StorageAccessError,
  );
  await expectThrow(
    "Sibling same-business token cannot finalize this project's document",
    () => finalizeProjectTokenDocument(deps, siblingJob.projectToken, authorized.asset.id),
    (error) => error instanceof StorageAccessError,
  );
  await expectThrow(
    "Unknown token cannot abort an owned pending document",
    () => abortProjectTokenDocument(deps, randomUUID(), authorized.asset.id),
    (error) => error instanceof StorageAccessError,
  );

  const stillPending = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: authorized.asset.id },
  });
  check(
    "Refused foreign/invalid finalize leaves the pending document untouched",
    stillPending.status === "PENDING" && stillPending.businessId === businessA.id,
  );

  console.log("\nDB — File limits and abort scope");
  await expectThrow(
    "Unsupported MIME is rejected before a stored asset is created",
    () =>
      authorizeProjectTokenDocument(deps, jobA.projectToken, {
        originalFilename: "notes.exe",
        mimeType: "application/x-msdownload",
        fileSizeBytes: 1000,
      }),
    (error) => error instanceof StorageError && error.message.includes("Unsupported file type"),
  );
  await expectThrow(
    "Oversize authorize payload is rejected",
    () =>
      authorizeProjectTokenDocument(deps, jobA.projectToken, {
        originalFilename: "huge.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: PROJECT_DOCUMENT_MAX_BYTES + 1,
      }),
    (error) => error instanceof StorageError && error.message.includes("too large"),
  );
  await expectThrow(
    "Finalize without a PUT does not mark the document READY",
    () => finalizeProjectTokenDocument(deps, jobA.projectToken, authorized.asset.id),
    (error) =>
      error instanceof StorageError && error.message.includes("not found in storage"),
  );
  await abortProjectTokenDocument(deps, jobA.projectToken, authorized.asset.id);
  const failedAsset = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: authorized.asset.id },
  });
  check("Failed upload is marked FAILED, not READY", failedAsset.status === "FAILED");

  const receipt = await authorizeManagedUpload(deps, businessA.id, {
    category: "ATTACHMENT",
    purpose: "expense-receipt",
    originalFilename: "receipt.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: pdfBytes.byteLength,
    visibility: "PRIVATE",
    jobId: jobA.id,
  });
  await expectThrow(
    "Token cannot abort a job-linked expense receipt",
    () => abortProjectTokenDocument(deps, jobA.projectToken, receipt.asset.id),
    (error) => error instanceof StorageAccessError,
  );
  const receiptAfter = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: receipt.asset.id },
  });
  check(
    "Foreign-purpose job-linked upload stays PENDING after refused abort",
    receiptAfter.status === "PENDING" && receiptAfter.purpose === "expense-receipt",
  );

  const mismatchAuth = await authorizeProjectTokenDocument(deps, jobA.projectToken, {
    originalFilename: "fake.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: jpeg.byteLength,
  });
  await provider.putObject({
    bucket: mismatchAuth.account.bucketName,
    key: mismatchAuth.asset.storageKey,
    body: jpeg,
    contentType: "application/pdf",
  });
  await expectThrow(
    "Finalize aborts when magic bytes do not match the declared MIME",
    () => finalizeProjectTokenDocument(deps, jobA.projectToken, mismatchAuth.asset.id),
    (error) => error instanceof StorageError && error.message === PROJECT_DOCUMENT_TYPE_MISMATCH,
  );
  const mismatchAfter = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: mismatchAuth.asset.id },
  });
  check("MIME-mismatch finalize leaves the asset FAILED, not READY", mismatchAfter.status === "FAILED");

  console.log("\nDB — Happy path stays private and does not change the Job");
  const saved = await putProjectTokenDocumentFromBytes(deps, jobA.projectToken, {
    originalFilename: "permit.pdf",
    mimeType: "application/pdf",
    body: pdfBytes,
  });
  check(
    "Valid token upload finalizes a READY private document",
    saved.status === "READY" &&
      saved.visibility === "PRIVATE" &&
      saved.publicPath == null &&
      saved.jobId === jobA.id &&
      saved.businessId === businessA.id &&
      saved.category === "DOCUMENT" &&
      saved.purpose === PROJECT_DOCUMENT_PURPOSE,
  );
  await expectThrow(
    "Token cannot abort a READY project document",
    () => abortProjectTokenDocument(deps, jobA.projectToken, saved.id),
    (error) => error instanceof StorageAccessError,
  );

  const after = await snapshot(jobA.id);
  check(
    "Upload does not change Job status, schedule, assignment, invoices, or messages",
    after.status === before.status &&
      after.status === "SCHEDULED" &&
      after.scheduledAt === before.scheduledAt &&
      after.assignedMembershipId === before.assignedMembershipId &&
      after.invoices === 0 &&
      after.messages === 0,
  );

  const portalList = await listProjectDocumentsForPortal(prisma, jobA.projectToken);
  check(
    "Portal receipt lists the filename without a download URL",
    portalList.length === 1 &&
      portalList[0].originalFilename === "permit.pdf" &&
      !("reviewHref" in portalList[0]),
  );
  const emptyPortal = await listProjectDocumentsForPortal(prisma, randomUUID());
  check("Unknown token portal list is empty", emptyPortal.length === 0);

  const ownerList = await listProjectDocumentsForOwnerReview(prisma, {
    businessId: businessA.id,
    jobId: jobA.id,
  });
  check(
    "Same-business review list includes the private download path",
    ownerList.length === 1 &&
      ownerList[0].id === saved.id &&
      ownerList[0].reviewHref === privateAssetPath(saved.id),
  );
  const foreignOwnerList = await listProjectDocumentsForOwnerReview(prisma, {
    businessId: businessB.id,
    jobId: jobA.id,
  });
  const siblingOwnerList = await listProjectDocumentsForOwnerReview(prisma, {
    businessId: businessA.id,
    jobId: siblingJob.id,
  });
  check(
    "Foreign business and sibling job review lists stay empty",
    foreignOwnerList.length === 0 && siblingOwnerList.length === 0,
  );

  console.log("\nDB — Private download authorization and tenant isolation");
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
  check(
    "Same-business OWNER and ADMIN get an authorized private download redirect",
    ownerRead.ok === true &&
      ownerRead.status === 302 &&
      ownerRead.url === `memory://download/tbbt-project-docs-test/${saved.storageKey}` &&
      ownerRead.expiresInSeconds === PRIVATE_DOWNLOAD_URL_TTL_SECONDS &&
      !("body" in ownerRead) &&
      adminRead.ok === true &&
      adminRead.url === ownerRead.url,
  );

  const ownerBytes = await servePrivateStoredAsset(prisma, saved.id, businessA.id, {
    provider,
    viewer: ownerViewer,
  });
  check(
    "Same-business OWNER can read the private document bytes in-process",
    ownerBytes.ok === true &&
      ownerBytes.status === 200 &&
      ownerBytes.contentType === "application/pdf",
  );

  const memberRead = await authorizePrivateStoredAssetDownload(
    prisma,
    saved.id,
    businessA.id,
    { provider, viewer: memberViewer },
  );
  check(
    "Same-business MEMBER cannot download a project document",
    memberRead.ok === false && memberRead.status === 404,
  );

  const betaRead = await authorizePrivateStoredAssetDownload(
    prisma,
    saved.id,
    businessB.id,
    { provider, viewer: betaViewer },
  );
  check(
    "Foreign-business OWNER cannot download tenant A's private document",
    betaRead.ok === false && betaRead.status === 404,
  );

  const publicLeak = await servePublicStoredAsset(prisma, saved.id, { provider });
  check("Public storage route cannot serve the private project document", publicLeak.ok === false);

  const savedB = await putProjectTokenDocumentFromBytes(deps, jobB.projectToken, {
    originalFilename: "beta.pdf",
    mimeType: "application/pdf",
    body: pdfBytes,
  });
  check(
    "Foreign token upload lands in that token's own business namespace",
    savedB.businessId === businessB.id &&
      savedB.jobId === jobB.id &&
      savedB.storageKey.startsWith(`businesses/${businessB.id}/documents/`),
  );
  const aCannotReviewB = await listProjectDocumentsForOwnerReview(prisma, {
    businessId: businessA.id,
    jobId: jobB.id,
  });
  const aCannotReadB = await authorizePrivateStoredAssetDownload(
    prisma,
    savedB.id,
    businessA.id,
    { provider, viewer: ownerViewer },
  );
  check(
    "Tenant A OWNER cannot list or download tenant B's project document",
    aCannotReviewB.length === 0 && aCannotReadB.ok === false && aCannotReadB.status === 404,
  );

  await expectThrow(
    "Token A cannot finalize a document authorized for token B",
    async () => {
      const pendingB = await authorizeProjectTokenDocument(deps, jobB.projectToken, {
        originalFilename: "other.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: pdfBytes.byteLength,
      });
      await finalizeProjectTokenDocument(deps, jobA.projectToken, pendingB.asset.id);
    },
    (error) => error instanceof StorageAccessError,
  );

  const websiteAsset = await authorizeManagedUpload(deps, businessA.id, {
    category: "WEBSITE_IMAGE",
    purpose: "not-a-project-document",
    originalFilename: "hero.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: jpeg.byteLength,
    visibility: "PUBLIC",
    jobId: jobA.id,
  });
  await provider.putObject({
    bucket: websiteAsset.account.bucketName,
    key: websiteAsset.asset.storageKey,
    body: jpeg,
    contentType: "image/jpeg",
  });
  const publicWebsite = await finalizeManagedUpload(deps, businessA.id, websiteAsset.asset.id);
  await expectThrow(
    "Project-token finalize refuses a PUBLIC website asset even on the same job",
    () => finalizeProjectTokenDocument(deps, jobA.projectToken, publicWebsite.id),
    (error) => error instanceof StorageError && error.message.includes("cannot be published"),
  );

  console.log("\nDB — Per-project document count limit");
  for (let i = 0; i < PROJECT_DOCUMENT_MAX_COUNT - 1; i += 1) {
    await putProjectTokenDocumentFromBytes(deps, jobA.projectToken, {
      originalFilename: `extra-${i}.pdf`,
      mimeType: "application/pdf",
      body: pdfBytes,
    });
  }
  const fullCount = await prisma.storedAsset.count({
    where: {
      jobId: jobA.id,
      purpose: PROJECT_DOCUMENT_PURPOSE,
      status: "READY",
    },
  });
  check("Project A now has the maximum number of ready documents", fullCount === PROJECT_DOCUMENT_MAX_COUNT);
  await expectThrow(
    "A sixth document on the same token is refused",
    () =>
      authorizeProjectTokenDocument(deps, jobA.projectToken, {
        originalFilename: "overflow.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: pdfBytes.byteLength,
      }),
    (error) => error instanceof StorageError && error.message.includes("up to"),
  );
  const siblingSaved = await putProjectTokenDocumentFromBytes(deps, siblingJob.projectToken, {
    originalFilename: "sibling.pdf",
    mimeType: "application/pdf",
    body: pdfBytes,
  });
  check(
    "Document count is per project token, not per business",
    siblingSaved.jobId === siblingJob.id && siblingSaved.status === "READY",
  );

  const afterLimit = await snapshot(jobA.id);
  check(
    "Hitting the file limit still does not change the Job or create invoices/messages",
    afterLimit.status === "SCHEDULED" &&
      afterLimit.invoices === 0 &&
      afterLimit.messages === 0,
  );

  console.log("\nDB — Atomic cap under parallel authorize");
  const parallel = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      authorizeProjectTokenDocument(deps, parallelJob.projectToken, {
        originalFilename: `race-${index}.pdf`,
        mimeType: "application/pdf",
        fileSizeBytes: pdfBytes.byteLength,
      }),
    ),
  );
  const parallelOk = parallel.filter((result) => result.status === "fulfilled");
  const parallelDenied = parallel.filter(
    (result) =>
      result.status === "rejected" &&
      result.reason instanceof StorageError &&
      String(result.reason.message).includes("up to"),
  );
  const pendingOnParallel = await prisma.storedAsset.count({
    where: {
      jobId: parallelJob.id,
      purpose: PROJECT_DOCUMENT_PURPOSE,
      status: "PENDING",
    },
  });
  check(
    "At most 5 of 8 parallel authorizes succeed",
    parallelOk.length <= PROJECT_DOCUMENT_MAX_COUNT &&
      parallelOk.length + parallelDenied.length === 8 &&
      pendingOnParallel <= PROJECT_DOCUMENT_MAX_COUNT,
  );
  check(
    "Exactly 5 parallel authorizes succeed against the locked job row",
    parallelOk.length === PROJECT_DOCUMENT_MAX_COUNT &&
      parallelDenied.length === 3 &&
      pendingOnParallel === PROJECT_DOCUMENT_MAX_COUNT,
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    /* ignore */
  }
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

if (failures > 0) {
  console.error(`\n${failures} project-document check(s) failed.`);
  process.exit(1);
}

console.log("\nAll project-document checks passed.");

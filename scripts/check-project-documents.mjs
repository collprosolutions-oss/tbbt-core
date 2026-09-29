/**
 * Project-token private documents: customer upload + OWNER review.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-project-documents.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  MemoryStorageProvider,
  PROJECT_DOCUMENT_MAX_BYTES,
  PROJECT_DOCUMENT_MAX_COUNT,
  PROJECT_DOCUMENT_PURPOSE,
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
  putProjectTokenDocumentFromBytes,
  remainingProjectDocumentSlots,
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

const testDbName = "tbbt_project_documents_test";
const parsed = new URL(baseUrl);
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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const libSrc = readRepo("src/lib/business-storage/project-documents.ts");
const actionSrc = readRepo("src/app/actions/public-project-documents.ts");
const portalFormSrc = readRepo("src/components/portal/project-document-upload.tsx");
const ownerListSrc = readRepo("src/components/jobs/project-document-review-list.tsx");
const portalPageSrc = readRepo("src/app/p/[token]/page.tsx");
const jobPageSrc = readRepo("src/app/(app)/jobs/[jobId]/page.tsx");
const privateRouteSrc = readRepo("src/app/api/storage/private/[assetId]/route.ts");

console.log("\nSTATIC — Token scope, private storage, no side effects");
check(
  "Authorize payload is metadata only (filename / MIME / size)",
  actionSrc.includes("originalFilename: input.originalFilename") &&
    actionSrc.includes("mimeType: input.mimeType") &&
    actionSrc.includes("fileSizeBytes: input.fileSizeBytes") &&
    actionSrc.includes("The file body never enters this action"),
);
check(
  "Public document actions never accept a client-supplied businessId or jobId",
  !actionSrc.includes("input.businessId") &&
    !actionSrc.includes("input.jobId") &&
    !actionSrc.includes('formData.get("businessId")') &&
    !actionSrc.includes('formData.get("jobId")') &&
    actionSrc.includes("input.projectToken") &&
    libSrc.includes("where: { projectToken: trimmed }"),
);
check(
  "Upload stays DOCUMENT + PRIVATE with the project-portal purpose",
  libSrc.includes('category: "DOCUMENT"') &&
    libSrc.includes('visibility: "PRIVATE"') &&
    libSrc.includes('PROJECT_DOCUMENT_PURPOSE = "project-portal-document"'),
);
check(
  "Portal form PUTs to the presigned URL and aborts on failure",
  portalFormSrc.includes("authorizeProjectDocumentUpload") &&
    portalFormSrc.includes("fetch(authorized.uploadUrl") &&
    portalFormSrc.includes("abortProjectDocumentUpload") &&
    portalFormSrc.includes("finalizeProjectDocumentUpload"),
);
check(
  "Portal receipts show filename only — no private download href for the customer",
  portalFormSrc.includes("pending owner review") &&
    !portalFormSrc.includes("/api/storage/private/") &&
    !portalFormSrc.includes("reviewHref"),
);
check(
  "Owner review uses the authenticated private asset path",
  ownerListSrc.includes("privateAssetPath") &&
    ownerListSrc.includes("Review file") &&
    ownerListSrc.includes("Not approved, published, or attached to an invoice"),
);
check(
  "Portal and job pages mention review without auto-approve or job change",
  portalPageSrc.includes("does not approve work, publish anything") &&
    jobPageSrc.includes("does not approve, publish, message, invoice, or") &&
    jobPageSrc.includes("listProjectDocumentsForOwnerReview"),
);
check(
  "Private download route still requires a business session",
  privateRouteSrc.includes("requireBusinessAccess") &&
    privateRouteSrc.includes("authorizePrivateStoredAssetDownload"),
);
check(
  "Lib never updates a Job, invoice, message, or writes a publicPath",
  !libSrc.includes("job.update") &&
    !libSrc.includes("invoice.create") &&
    !libSrc.includes("customerCommunication") &&
    !libSrc.includes('visibility: "PUBLIC"') &&
    !libSrc.includes("publicPath: publicAssetPath") &&
    !libSrc.includes('publicPath: `/api/storage/public') &&
    libSrc.includes("Project documents cannot be published."),
);
check(
  "Configured document ceiling is 8 MB and 5 files per project",
  PROJECT_DOCUMENT_MAX_BYTES === 8 * 1024 * 1024 &&
    PROJECT_DOCUMENT_MAX_COUNT === 5 &&
    remainingProjectDocumentSlots(0) === 5 &&
    remainingProjectDocumentSlots(5) === 0 &&
    remainingProjectDocumentSlots(16) === 0,
);

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

console.log("\nPURE — MIME and size gates");
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

const pdfBytes = Buffer.from("%PDF-1.4 customer-doc\n%%EOF\n");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3, 4]);

try {
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-pdoc-${randomUUID()}@example.com`, passwordHash: "x" },
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

  console.log("\nDB — Invalid / foreign token refusal");
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

  console.log("\nDB — File limits");
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
    () => true,
  );
  await abortProjectTokenDocument(deps, jobA.projectToken, authorized.asset.id);
  const failedAsset = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: authorized.asset.id },
  });
  check("Failed upload is marked FAILED, not READY", failedAsset.status === "FAILED");

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
    "Same-business OWNER review list includes the private download path",
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
  const memberViewer = { role: "MEMBER", membershipId: memberMem.id };
  const betaViewer = { role: "OWNER", membershipId: betaMem.id };

  const ownerRead = await authorizePrivateStoredAssetDownload(
    prisma,
    saved.id,
    businessA.id,
    { provider, viewer: ownerViewer },
  );
  check(
    "Same-business OWNER gets an authorized private download redirect",
    ownerRead.ok === true &&
      ownerRead.status === 302 &&
      ownerRead.url === `memory://download/tbbt-project-docs-test/${saved.storageKey}` &&
      ownerRead.expiresInSeconds === PRIVATE_DOWNLOAD_URL_TTL_SECONDS &&
      !("body" in ownerRead),
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
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\n${failures} project-document check(s) failed.`);
  process.exit(1);
}

console.log("\nAll project-document checks passed.");

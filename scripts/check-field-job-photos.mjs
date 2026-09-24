/**
 * Field job photos on the existing private R2 browser-upload path.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-field-job-photos.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  FIELD_JOB_PHOTO_MAX_BYTES,
  MemoryStorageProvider,
  REQUEST_PHOTO_MAX_BYTES,
  StorageAccessError,
  StorageError,
  abortAssignedFieldJobPhoto,
  abortManagementJobPhoto,
  authorizeAssignedFieldJobPhoto,
  authorizeManagementJobPhoto,
  finalizeAssignedFieldJobPhoto,
  inspectFieldJobPhotoUpload,
  isBusinessStorageConfigured,
  jobPhotoSrc,
  privateAssetPath,
  PRIVATE_DOWNLOAD_URL_TTL_SECONDS,
  putAssignedFieldJobPhotoFromBytes,
  putManagementJobPhotoFromBytes,
  authorizePrivateStoredAssetDownload,
} = await import("@/lib/business-storage/index");
const { authorizeManagedUpload, finalizeManagedUpload } = await import(
  "@/lib/business-storage/service"
);
const { putPublicRequestPhotoFromBytes } = await import(
  "@/lib/business-storage/request-photos"
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_field_job_photos_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for field job photo test database.");
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

const fieldActionSrc = readRepo("src/app/actions/field-job.ts");
const fieldFormSrc = readRepo("src/components/field/add-field-job-photo-form.tsx");
const fieldPhotoLibSrc = readRepo("src/lib/business-storage/field-job-photos.ts");
const privateServeSrc = readRepo("src/lib/business-storage/private-serve.ts");
const privateRouteSrc = readRepo("src/app/api/storage/private/[assetId]/route.ts");
const storageSrc = readRepo("src/lib/storage.ts");
const ownerPhotoSrc = readRepo("src/app/actions/job-photo.ts");
const ownerFormSrc = readRepo("src/components/jobs/add-job-photo-form.tsx");

console.log("\nSTATIC — Field photos leave the 4 MB server-action body path");
check(
  "Field photo actions never accept a File or Vercel Blob upload helper",
  !fieldActionSrc.includes("uploadJobPhoto") &&
    !fieldActionSrc.includes('formData.get("file")') &&
    !fieldActionSrc.includes("MAX_JOB_PHOTO_UPLOAD_BYTES") &&
    !fieldActionSrc.includes("instanceof File"),
);
check(
  "Field photo authorize payload is metadata only (filename / MIME / size)",
  fieldActionSrc.includes("originalFilename: input.originalFilename") &&
    fieldActionSrc.includes("mimeType: input.mimeType") &&
    fieldActionSrc.includes("fileSizeBytes: input.fileSizeBytes") &&
    fieldActionSrc.includes("The image body never enters this"),
);
const authorizeSig = fieldActionSrc.match(
  /export async function authorizeAssignedJobPhotoUpload\(input: \{[^}]+\}\)/,
);
check(
  "Field photo authorize input has no client-supplied businessId",
  Boolean(authorizeSig) &&
    !authorizeSig[0].includes("businessId") &&
    !fieldActionSrc.includes('formData.get("businessId")') &&
    !fieldActionSrc.includes("input.businessId"),
);
check(
  "Field form PUTs the camera file to the presigned URL and aborts on failure",
  fieldFormSrc.includes('capture="environment"') &&
    fieldFormSrc.includes("authorizeAssignedJobPhotoUpload") &&
    fieldFormSrc.includes("fetch(authorized.uploadUrl") &&
    fieldFormSrc.includes("abortAssignedJobPhotoUpload") &&
    fieldFormSrc.includes("finalizeAssignedJobPhotoUpload"),
);
check(
  "Configured field photo ceiling is the phone-sized 12 MB request-photo limit",
  FIELD_JOB_PHOTO_MAX_BYTES === REQUEST_PHOTO_MAX_BYTES &&
    FIELD_JOB_PHOTO_MAX_BYTES === 12 * 1024 * 1024 &&
    fieldPhotoLibSrc.includes("FIELD_JOB_PHOTO_MAX_BYTES = REQUEST_PHOTO_MAX_BYTES"),
);
check(
  "Legacy Blob helper remains for historical rows only, not new owner uploads",
  storageSrc.includes("MAX_JOB_PHOTO_UPLOAD_BYTES = 4 * 1024 * 1024") &&
    storageSrc.includes("export async function uploadJobPhoto") &&
    !ownerPhotoSrc.includes("MAX_JOB_PHOTO_UPLOAD_BYTES") &&
    !ownerPhotoSrc.includes("uploadJobPhoto") &&
    !ownerPhotoSrc.includes("isStorageConfigured") &&
    ownerPhotoSrc.includes("deleteJobPhotoBlob"),
);
check(
  "Owner/admin photo actions never accept a File or Vercel Blob upload helper",
  !ownerPhotoSrc.includes("uploadJobPhoto") &&
    !ownerPhotoSrc.includes('formData.get("file")') &&
    !ownerPhotoSrc.includes("MAX_JOB_PHOTO_UPLOAD_BYTES") &&
    !ownerPhotoSrc.includes("instanceof File") &&
    ownerPhotoSrc.includes("authorizeManagementJobPhoto") &&
    ownerPhotoSrc.includes("finalizeManagementJobPhoto") &&
    ownerPhotoSrc.includes("abortManagementJobPhoto") &&
    ownerPhotoSrc.includes("The image body never enters this"),
);
check(
  "Owner/admin authorize payload is metadata only (filename / MIME / size)",
  ownerPhotoSrc.includes("originalFilename: input.originalFilename") &&
    ownerPhotoSrc.includes("mimeType: input.mimeType") &&
    ownerPhotoSrc.includes("fileSizeBytes: input.fileSizeBytes") &&
    !ownerPhotoSrc.includes("BLOB_READ_WRITE_TOKEN"),
);
const ownerAuthorizeSig = ownerPhotoSrc.match(
  /export async function authorizeManagementJobPhotoUpload\(input: \{[^}]+\}\)/,
);
check(
  "Owner/admin photo authorize input has no client-supplied businessId",
  Boolean(ownerAuthorizeSig) &&
    !ownerAuthorizeSig[0].includes("businessId") &&
    !ownerPhotoSrc.includes('formData.get("businessId")') &&
    !ownerPhotoSrc.includes("input.businessId"),
);
check(
  "Owner form PUTs the file to the presigned URL and aborts on failure",
  ownerFormSrc.includes("authorizeManagementJobPhotoUpload") &&
    ownerFormSrc.includes("fetch(authorized.uploadUrl") &&
    ownerFormSrc.includes("abortManagementJobPhotoUpload") &&
    ownerFormSrc.includes("finalizeManagementJobPhotoUpload") &&
    !ownerFormSrc.includes("addJobPhoto") &&
    !ownerFormSrc.includes("useActionState"),
);
check(
  "Missing R2 configuration returns a clear operational error",
  fieldActionSrc.includes("isBusinessStorageConfigured()") &&
    fieldActionSrc.includes("Ask an admin to connect platform file storage (Cloudflare R2)"),
);
check(
  "Owner job-photo storage error names Cloudflare R2, not Vercel Blob",
  ownerPhotoSrc.includes("Ask an admin to connect platform file storage (Cloudflare R2)") &&
    !ownerPhotoSrc.includes("BLOB_READ_WRITE_TOKEN") &&
    !ownerPhotoSrc.includes("Vercel Blob"),
);
check(
  "Private asset route derives viewer role and membership from the session workspace",
  privateRouteSrc.includes("access.workspace.role") &&
    privateRouteSrc.includes("access.workspace.membership.id") &&
    privateRouteSrc.includes("access.businessId") &&
    !privateRouteSrc.includes("searchParams") &&
    !privateRouteSrc.includes("businessId="),
);
check(
  "MEMBER private reads require an assigned JOB_PHOTO; OWNER/ADMIN stay business-wide",
  privateServeSrc.includes("canAccessManagementConsole") &&
    privateServeSrc.includes('category !== "JOB_PHOTO"') &&
    privateServeSrc.includes("assignedMembershipId: input.membershipId") &&
    privateServeSrc.includes('body: "Not found"'),
);
check(
  "Private route redirects to a short-lived signed GET and never streams R2 bytes through Next",
  privateRouteSrc.includes("authorizePrivateStoredAssetDownload") &&
    privateRouteSrc.includes("NextResponse.redirect") &&
    !privateRouteSrc.includes("servePrivateStoredAsset") &&
    !privateRouteSrc.includes("Buffer.from") &&
    !privateRouteSrc.includes("getObject(") &&
    privateServeSrc.includes("createDownloadUrl") &&
    privateServeSrc.includes("getObjectMetadata"),
);

const savedR2 = {
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
};
delete process.env.R2_ACCOUNT_ID;
delete process.env.R2_ACCESS_KEY_ID;
delete process.env.R2_SECRET_ACCESS_KEY;
delete process.env.R2_BUCKET_NAME;
check(
  "isBusinessStorageConfigured() is false when R2 env vars are missing",
  isBusinessStorageConfigured() === false,
);
for (const [key, value] of Object.entries(savedR2)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const jpegOk = inspectFieldJobPhotoUpload({
  type: "image/jpeg",
  name: "phone.jpg",
  size: 5 * 1024 * 1024,
});
const heicOk = inspectFieldJobPhotoUpload({
  type: "image/heic",
  name: "IMG_0001.HEIC",
  size: 8 * 1024 * 1024,
});
const pdfNo = inspectFieldJobPhotoUpload({
  type: "application/pdf",
  name: "notes.pdf",
  size: 1000,
});
const gifNo = inspectFieldJobPhotoUpload({
  type: "image/gif",
  name: "loop.gif",
  size: 1000,
});
const oversizeNo = inspectFieldJobPhotoUpload({
  type: "image/jpeg",
  name: "huge.jpg",
  size: FIELD_JOB_PHOTO_MAX_BYTES + 1,
});

console.log("\nPURE — MIME and size gates");
check(
  "A 5 MB JPEG (over the old 4 MB action cap) is accepted for field upload",
  jpegOk.ok === true && jpegOk.mimeType === "image/jpeg",
);
check("HEIC phone photos are accepted", heicOk.ok === true && heicOk.mimeType === "image/heic");
check(
  "Unsupported MIME types are rejected",
  pdfNo.ok === false &&
    pdfNo.error.includes("Unsupported file type") &&
    gifNo.ok === false,
);
check(
  "Configured max upload size is enforced",
  oversizeNo.ok === false && oversizeNo.error.includes("too large"),
);
check(
  "Legacy Blob URLs keep rendering; R2 rows use the private asset path",
  jobPhotoSrc({
    url: "https://example.blob.vercel-storage.com/legacy.jpg",
    storedAssetId: null,
  }) === "https://example.blob.vercel-storage.com/legacy.jpg" &&
    jobPhotoSrc({ url: "https://unused.example/old.jpg", storedAssetId: "asset_1" }) ===
      privateAssetPath("asset_1"),
);

try {
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-fjp-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-fjp-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-fjp-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const otherMemberUser = await prisma.user.create({
    data: { name: "Max Other", email: `other-fjp-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-fjp-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Field Photos", slug: `alpha-fjp-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Field Photos", slug: `beta-fjp-${randomUUID()}`, tradeCode: "HANDYMAN" },
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
  const otherMem = await prisma.membership.create({
    data: { userId: otherMemberUser.id, businessId: businessA.id, role: "MEMBER" },
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
  const assignedJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      assignedMembershipId: memberMem.id,
    },
  });
  const ownerAssignedJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      assignedMembershipId: ownerMem.id,
    },
  });
  const otherAssignedJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      assignedMembershipId: otherMem.id,
    },
  });
  const unassignedJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
    },
  });
  const foreignJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      assignedMembershipId: betaMem.id,
    },
  });

  const assignedField = { businessId: businessA.id, membershipId: memberMem.id };
  const otherField = { businessId: businessA.id, membershipId: otherMem.id };
  const ownerField = { businessId: businessA.id, membershipId: ownerMem.id };
  const betaField = { businessId: businessB.id, membershipId: betaMem.id };
  const forgedTenantField = { businessId: businessB.id, membershipId: memberMem.id };

  const provider = new MemoryStorageProvider();
  const deps = {
    db: prisma,
    provider,
    bucketName: "tbbt-field-photos-test",
    defaultLimitBytes: 50 * 1024 * 1024,
  };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3, 4]);

  console.log("\nDB — Assignment, tenant scope, persist, and failed upload");

  const authorized = await authorizeAssignedFieldJobPhoto(deps, assignedField, {
    jobId: assignedJob.id,
    originalFilename: "phone.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: jpeg.byteLength,
  });
  check(
    "Authorized field user can request an upload for their assigned job",
    authorized.asset.businessId === businessA.id &&
      authorized.asset.jobId === assignedJob.id &&
      authorized.asset.category === "JOB_PHOTO" &&
      authorized.asset.visibility === "PRIVATE" &&
      authorized.asset.status === "PENDING" &&
      authorized.asset.storageKey.startsWith(`businesses/${businessA.id}/jobs/`) &&
      authorized.upload.method === "PUT" &&
      Boolean(authorized.upload.url),
  );
  check(
    "Presigned upload never exposes R2 credentials or a public write path",
    !authorized.upload.url.includes("R2_SECRET") &&
      authorized.asset.publicPath == null &&
      authorized.asset.visibility === "PRIVATE",
  );

  await expectThrow(
    "Unassigned same-business member cannot authorize an upload",
    () =>
      authorizeAssignedFieldJobPhoto(deps, otherField, {
        jobId: assignedJob.id,
        originalFilename: "phone.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: jpeg.byteLength,
      }),
    (error) => error instanceof StorageAccessError && error.message.includes("isn't assigned"),
  );
  await expectThrow(
    "Assigned member cannot authorize an unassigned job",
    () =>
      authorizeAssignedFieldJobPhoto(deps, assignedField, {
        jobId: unassignedJob.id,
        originalFilename: "phone.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: jpeg.byteLength,
      }),
    (error) => error instanceof StorageAccessError,
  );
  await expectThrow(
    "Foreign/unassigned job is rejected",
    () =>
      authorizeAssignedFieldJobPhoto(deps, assignedField, {
        jobId: foreignJob.id,
        originalFilename: "phone.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: jpeg.byteLength,
      }),
    (error) => error instanceof StorageAccessError,
  );
  await expectThrow(
    "Browser-supplied business identity cannot cross tenants",
    () =>
      authorizeAssignedFieldJobPhoto(deps, forgedTenantField, {
        jobId: assignedJob.id,
        originalFilename: "phone.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: jpeg.byteLength,
      }),
    (error) => error instanceof StorageAccessError,
  );
  await expectThrow(
    "Business B cannot authorize a Business A job even when assigned on B",
    () =>
      authorizeAssignedFieldJobPhoto(deps, betaField, {
        jobId: assignedJob.id,
        originalFilename: "phone.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: jpeg.byteLength,
      }),
    (error) => error instanceof StorageAccessError,
  );

  const ownerAuthorized = await authorizeAssignedFieldJobPhoto(deps, ownerField, {
    jobId: ownerAssignedJob.id,
    originalFilename: "owner.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: jpeg.byteLength,
  });
  check(
    "OWNER can authorize an upload only for a job assigned to themselves",
    ownerAuthorized.asset.jobId === ownerAssignedJob.id &&
      ownerAuthorized.asset.businessId === businessA.id,
  );
  await abortAssignedFieldJobPhoto(deps, ownerField, {
    jobId: ownerAssignedJob.id,
    assetId: ownerAuthorized.asset.id,
  });
  await expectThrow(
    "OWNER cannot upload to a member-assigned job they are not assigned to",
    () =>
      authorizeAssignedFieldJobPhoto(deps, ownerField, {
        jobId: assignedJob.id,
        originalFilename: "owner.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: jpeg.byteLength,
      }),
    (error) => error instanceof StorageAccessError,
  );

  await expectThrow(
    "Unsupported MIME is rejected before a stored asset is created",
    () =>
      authorizeAssignedFieldJobPhoto(deps, assignedField, {
        jobId: assignedJob.id,
        originalFilename: "notes.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 1000,
      }),
    (error) => error instanceof StorageError && error.message.includes("Unsupported file type"),
  );
  await expectThrow(
    "Oversize authorize payload is rejected",
    () =>
      authorizeAssignedFieldJobPhoto(deps, assignedField, {
        jobId: assignedJob.id,
        originalFilename: "huge.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: FIELD_JOB_PHOTO_MAX_BYTES + 1,
      }),
    (error) => error instanceof StorageError && error.message.includes("too large"),
  );

  const photosBeforeFail = await prisma.jobPhoto.count({ where: { jobId: assignedJob.id } });
  await expectThrow(
    "Finalize without a PUT does not create a JobPhoto",
    () =>
      finalizeAssignedFieldJobPhoto(deps, assignedField, {
        jobId: assignedJob.id,
        assetId: authorized.asset.id,
        stage: "BEFORE",
      }),
    () => true,
  );
  await abortAssignedFieldJobPhoto(deps, assignedField, {
    jobId: assignedJob.id,
    assetId: authorized.asset.id,
  });
  const photosAfterFail = await prisma.jobPhoto.count({ where: { jobId: assignedJob.id } });
  const failedAsset = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: authorized.asset.id },
  });
  check(
    "Failed upload does not create a broken photo record",
    photosAfterFail === photosBeforeFail && failedAsset.status === "FAILED",
  );

  const saved = await putAssignedFieldJobPhotoFromBytes(deps, assignedField, {
    jobId: assignedJob.id,
    originalFilename: "after.jpg",
    mimeType: "image/jpeg",
    body: jpeg,
    stage: "AFTER",
    caption: "Valve after repair",
  });
  check(
    "New R2-backed job photo persists with a private asset path",
    saved.photo.jobId === assignedJob.id &&
      saved.photo.storedAssetId === saved.asset.id &&
      saved.photo.url === privateAssetPath(saved.asset.id) &&
      saved.photo.stage === "AFTER" &&
      saved.photo.caption === "Valve after repair" &&
      saved.asset.status === "READY" &&
      saved.asset.visibility === "PRIVATE" &&
      saved.asset.publicPath == null,
  );
  const assignedViewer = { role: "MEMBER", membershipId: memberMem.id };
  const otherViewer = { role: "MEMBER", membershipId: otherMem.id };
  const ownerViewer = { role: "OWNER", membershipId: ownerMem.id };
  const adminViewer = { role: "ADMIN", membershipId: adminMem.id };
  const betaViewer = { role: "OWNER", membershipId: betaMem.id };

  const assignedRead = await authorizePrivateStoredAssetDownload(
    prisma,
    saved.asset.id,
    businessA.id,
    { provider, viewer: assignedViewer },
  );
  check(
    "Assigned MEMBER gets an authorized private download redirect, not object bytes",
    assignedRead.ok === true &&
      assignedRead.status === 302 &&
      assignedRead.url === `memory://download/tbbt-field-photos-test/${saved.asset.storageKey}` &&
      assignedRead.expiresInSeconds === PRIVATE_DOWNLOAD_URL_TTL_SECONDS &&
      !("body" in assignedRead) &&
      jobPhotoSrc(saved.photo) === privateAssetPath(saved.asset.id),
  );

  const otherRead = await authorizePrivateStoredAssetDownload(
    prisma,
    saved.asset.id,
    businessA.id,
    { provider, viewer: otherViewer },
  );
  check(
    "Another MEMBER in the same business cannot read that Job photo",
    otherRead.ok === false && otherRead.status === 404 && otherRead.body === "Not found",
  );

  const otherSaved = await putAssignedFieldJobPhotoFromBytes(deps, otherField, {
    jobId: otherAssignedJob.id,
    originalFilename: "other.jpg",
    mimeType: "image/jpeg",
    body: jpeg,
    stage: "BEFORE",
  });
  const otherJobReadByAssigned = await authorizePrivateStoredAssetDownload(
    prisma,
    otherSaved.asset.id,
    businessA.id,
    { provider, viewer: assignedViewer },
  );
  check(
    "MEMBER cannot retrieve another member's assigned Job photo",
    otherJobReadByAssigned.ok === false && otherJobReadByAssigned.status === 404,
  );

  const unassignedAuth = await authorizeManagedUpload(deps, businessA.id, {
    category: "JOB_PHOTO",
    purpose: "unassigned-job-photo",
    originalFilename: "unassigned.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: jpeg.byteLength,
    visibility: "PRIVATE",
    jobId: unassignedJob.id,
  });
  await provider.putObject({
    bucket: unassignedAuth.account.bucketName,
    key: unassignedAuth.asset.storageKey,
    body: jpeg,
    contentType: "image/jpeg",
  });
  const unassignedAsset = await finalizeManagedUpload(
    deps,
    businessA.id,
    unassignedAuth.asset.id,
  );
  const unassignedRead = await authorizePrivateStoredAssetDownload(
    prisma,
    unassignedAsset.id,
    businessA.id,
    { provider, viewer: assignedViewer },
  );
  check(
    "MEMBER cannot retrieve an unassigned Job photo",
    unassignedRead.ok === false && unassignedRead.status === 404,
  );

  const requestPhoto = await putPublicRequestPhotoFromBytes(deps, businessA.slug, {
    originalFilename: "intake.jpg",
    mimeType: "image/jpeg",
    body: jpeg,
  });
  const customerPhotoRead = await authorizePrivateStoredAssetDownload(
    prisma,
    requestPhoto.id,
    businessA.id,
    { provider, viewer: assignedViewer },
  );
  check(
    "MEMBER cannot retrieve a CUSTOMER_PHOTO from the same business",
    customerPhotoRead.ok === false &&
      customerPhotoRead.status === 404 &&
      customerPhotoRead.body === "Not found",
  );

  const ownerRead = await authorizePrivateStoredAssetDownload(
    prisma,
    saved.asset.id,
    businessA.id,
    { provider, viewer: ownerViewer },
  );
  const adminRead = await authorizePrivateStoredAssetDownload(
    prisma,
    saved.asset.id,
    businessA.id,
    { provider, viewer: adminViewer },
  );
  const ownerRequestRead = await authorizePrivateStoredAssetDownload(
    prisma,
    requestPhoto.id,
    businessA.id,
    { provider, viewer: ownerViewer },
  );
  check(
    "OWNER/ADMIN still get an authorized private download for Job and management assets",
    ownerRead.ok === true &&
      ownerRead.url === `memory://download/tbbt-field-photos-test/${saved.asset.storageKey}` &&
      !("body" in ownerRead) &&
      adminRead.ok === true &&
      adminRead.url === ownerRead.url &&
      ownerRequestRead.ok === true &&
      ownerRequestRead.url.startsWith("memory://download/"),
  );

  const largePhoto = Buffer.alloc(5 * 1024 * 1024 + 64, 7);
  largePhoto[0] = 0xff;
  largePhoto[1] = 0xd8;
  largePhoto[2] = 0xff;
  largePhoto[3] = 0xd9;
  const largeSaved = await putAssignedFieldJobPhotoFromBytes(deps, assignedField, {
    jobId: assignedJob.id,
    originalFilename: "phone-5mb.jpg",
    mimeType: "image/jpeg",
    body: largePhoto,
    stage: "DURING",
  });
  const largeRead = await authorizePrivateStoredAssetDownload(
    prisma,
    largeSaved.asset.id,
    businessA.id,
    { provider, viewer: assignedViewer },
  );
  check(
    "A 5+ MB field photo authorizes a signed download without a Vercel response body",
    largeSaved.asset.fileSizeBytes > 4 * 1024 * 1024 &&
      largeRead.ok === true &&
      largeRead.status === 302 &&
      largeRead.url === `memory://download/tbbt-field-photos-test/${largeSaved.asset.storageKey}` &&
      !("body" in largeRead) &&
      !("contentLength" in largeRead),
  );

  const crossRead = await authorizePrivateStoredAssetDownload(
    prisma,
    saved.asset.id,
    businessB.id,
    { provider, viewer: betaViewer },
  );
  const forgedRead = await authorizePrivateStoredAssetDownload(
    prisma,
    saved.asset.id,
    businessB.id,
    { provider, viewer: { role: "MEMBER", membershipId: memberMem.id } },
  );
  check(
    "Cross-business private Job photo access remains denied",
    crossRead.ok === false &&
      crossRead.status === 404 &&
      forgedRead.ok === false &&
      forgedRead.status === 404,
  );

  const legacy = await prisma.jobPhoto.create({
    data: {
      businessId: businessA.id,
      jobId: assignedJob.id,
      stage: "BEFORE",
      url: "https://example.blob.vercel-storage.com/legacy-field.jpg",
    },
  });
  check(
    "Existing Blob-backed job photos still render from the Blob URL",
    jobPhotoSrc(legacy) === legacy.url && legacy.storedAssetId == null,
  );

  const listed = await prisma.jobPhoto.findMany({
    where: { jobId: assignedJob.id },
    orderBy: { createdAt: "asc" },
  });
  check(
    "Job photo listing can dual-read Blob and R2 rows on the same job",
    listed.some((row) => row.id === legacy.id && jobPhotoSrc(row) === legacy.url) &&
      listed.some((row) => row.id === saved.photo.id && jobPhotoSrc(row) === privateAssetPath(saved.asset.id)),
  );

  console.log("\nDB — OWNER/ADMIN management photos on private R2");

  const managementA = { businessId: businessA.id };
  const managementB = { businessId: businessB.id };

  const ownerUnassignedAuth = await authorizeManagementJobPhoto(deps, managementA, {
    jobId: unassignedJob.id,
    originalFilename: "owner-unassigned.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: jpeg.byteLength,
  });
  check(
    "OWNER/ADMIN can authorize an upload for an unassigned business-owned job",
    ownerUnassignedAuth.asset.businessId === businessA.id &&
      ownerUnassignedAuth.asset.jobId === unassignedJob.id &&
      ownerUnassignedAuth.asset.category === "JOB_PHOTO" &&
      ownerUnassignedAuth.asset.visibility === "PRIVATE" &&
      ownerUnassignedAuth.asset.status === "PENDING" &&
      ownerUnassignedAuth.asset.storageKey.startsWith(`businesses/${businessA.id}/jobs/`) &&
      ownerUnassignedAuth.upload.method === "PUT" &&
      Boolean(ownerUnassignedAuth.upload.url),
  );
  await abortManagementJobPhoto(deps, managementA, {
    jobId: unassignedJob.id,
    assetId: ownerUnassignedAuth.asset.id,
  });

  const ownerAssignedAuth = await authorizeManagementJobPhoto(deps, managementA, {
    jobId: assignedJob.id,
    originalFilename: "owner-assigned.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: jpeg.byteLength,
  });
  check(
    "OWNER/ADMIN can authorize an upload for a member-assigned job without being assigned",
    ownerAssignedAuth.asset.jobId === assignedJob.id &&
      ownerAssignedAuth.asset.businessId === businessA.id &&
      ownerAssignedAuth.asset.visibility === "PRIVATE",
  );
  await abortManagementJobPhoto(deps, managementA, {
    jobId: assignedJob.id,
    assetId: ownerAssignedAuth.asset.id,
  });

  await expectThrow(
    "Foreign-business job cannot receive an OWNER/ADMIN photo",
    () =>
      authorizeManagementJobPhoto(deps, managementA, {
        jobId: foreignJob.id,
        originalFilename: "foreign.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: jpeg.byteLength,
      }),
    (error) => error instanceof StorageAccessError && error.message.includes("could not be found"),
  );
  await expectThrow(
    "Business B cannot authorize an OWNER/ADMIN photo on a Business A job",
    () =>
      authorizeManagementJobPhoto(deps, managementB, {
        jobId: assignedJob.id,
        originalFilename: "cross-tenant.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: jpeg.byteLength,
      }),
    (error) => error instanceof StorageAccessError,
  );
  await expectThrow(
    "Browser-supplied business identity cannot cross tenants for owner/admin photos",
    () =>
      authorizeManagementJobPhoto(deps, { businessId: businessB.id }, {
        jobId: unassignedJob.id,
        originalFilename: "forged.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: jpeg.byteLength,
      }),
    (error) => error instanceof StorageAccessError,
  );

  const ownerSaved = await putManagementJobPhotoFromBytes(deps, managementA, {
    jobId: unassignedJob.id,
    originalFilename: "owner-after.jpg",
    mimeType: "image/jpeg",
    body: jpeg,
    stage: "AFTER",
    caption: "Owner photo after repair",
  });
  check(
    "New OWNER/ADMIN job photo persists as a PRIVATE R2 StoredAsset",
    ownerSaved.photo.jobId === unassignedJob.id &&
      ownerSaved.photo.businessId === businessA.id &&
      ownerSaved.photo.storedAssetId === ownerSaved.asset.id &&
      ownerSaved.photo.url === privateAssetPath(ownerSaved.asset.id) &&
      ownerSaved.photo.stage === "AFTER" &&
      ownerSaved.photo.caption === "Owner photo after repair" &&
      ownerSaved.asset.status === "READY" &&
      ownerSaved.asset.visibility === "PRIVATE" &&
      ownerSaved.asset.category === "JOB_PHOTO" &&
      ownerSaved.asset.publicPath == null &&
      ownerSaved.asset.storageKey.startsWith(`businesses/${businessA.id}/jobs/`),
  );

  const ownerPhotoRead = await authorizePrivateStoredAssetDownload(
    prisma,
    ownerSaved.asset.id,
    businessA.id,
    { provider, viewer: ownerViewer },
  );
  const adminPhotoRead = await authorizePrivateStoredAssetDownload(
    prisma,
    ownerSaved.asset.id,
    businessA.id,
    { provider, viewer: adminViewer },
  );
  const betaOwnerPhotoRead = await authorizePrivateStoredAssetDownload(
    prisma,
    ownerSaved.asset.id,
    businessB.id,
    { provider, viewer: betaViewer },
  );
  check(
    "OWNER/ADMIN can read their private R2 job photo; foreign business cannot",
    ownerPhotoRead.ok === true &&
      ownerPhotoRead.status === 302 &&
      !("body" in ownerPhotoRead) &&
      adminPhotoRead.ok === true &&
      betaOwnerPhotoRead.ok === false &&
      betaOwnerPhotoRead.status === 404,
  );

  const bAssets = await prisma.storedAsset.findMany({ where: { businessId: businessB.id } });
  check("Business B stays empty when A uploads field and owner photos", bAssets.length === 0);
} finally {
  await prisma.$disconnect();
  spawnSync("psql", [baseUrl, "-c", `DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE);`], {
    stdio: "ignore",
  });
}

if (failures > 0) {
  console.error(`\n${failures} field job photo check(s) failed.`);
  process.exit(1);
}
console.log("\nField job photo checks passed.");

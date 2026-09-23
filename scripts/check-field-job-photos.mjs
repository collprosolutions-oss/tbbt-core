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
  authorizeAssignedFieldJobPhoto,
  finalizeAssignedFieldJobPhoto,
  inspectFieldJobPhotoUpload,
  isBusinessStorageConfigured,
  jobPhotoSrc,
  privateAssetPath,
  putAssignedFieldJobPhotoFromBytes,
} = await import("@/lib/business-storage/index");

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
const storageSrc = readRepo("src/lib/storage.ts");
const ownerPhotoSrc = readRepo("src/app/actions/job-photo.ts");

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
check(
  "Field photo authorize input has no client-supplied businessId",
  !/authorizeAssignedJobPhotoUpload\(input: \{[\s\S]*?businessId/.test(fieldActionSrc) &&
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
  "Owner Blob job-photo path stays on the 4 MB server-action ceiling",
  storageSrc.includes("MAX_JOB_PHOTO_UPLOAD_BYTES = 4 * 1024 * 1024") &&
    ownerPhotoSrc.includes("MAX_JOB_PHOTO_UPLOAD_BYTES") &&
    ownerPhotoSrc.includes("uploadJobPhoto"),
);
check(
  "Missing R2 configuration returns a clear operational error",
  fieldActionSrc.includes("isBusinessStorageConfigured()") &&
    fieldActionSrc.includes("Ask an admin to connect platform file storage (Cloudflare R2)"),
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
  check(
    "New R2-backed job photo renders through the private serve path",
    jobPhotoSrc(saved.photo) === `/api/storage/private/${saved.asset.id}`,
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

  const bAssets = await prisma.storedAsset.findMany({ where: { businessId: businessB.id } });
  check("Business B stays empty when A uploads a field photo", bAssets.length === 0);
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

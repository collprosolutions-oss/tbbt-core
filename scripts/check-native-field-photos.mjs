/**
 * Native assigned-job photos — reuse private field-job-photo storage,
 * assignment isolation, upload caps, and clear errors.
 *
 * Imports the REAL production helpers from src/lib/native-field.ts and
 * src/lib/native-field-photos.ts. Uses a disposable sibling Postgres
 * database (`tbbt_native_field_photos_test`).
 *
 * Run with:
 *   npm run test:native-field-photos
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { hashPassword } = await import("@/lib/auth-crypto");
const { MemoryStorageProvider } = await import("@/lib/business-storage/index");
const {
  authorizeManagedUpload,
  finalizeManagedUpload,
} = await import("@/lib/business-storage/service");
const { FIELD_JOB_PHOTO_MAX_BYTES } = await import(
  "@/lib/business-storage/field-job-photos"
);
const { PRIVATE_DOWNLOAD_URL_TTL_SECONDS } = await import(
  "@/lib/business-storage/types"
);
const {
  NATIVE_JOB_PHOTO_LIMIT,
  loadNativeAssignedJob,
  nativeJobPhotoTooManyMessage,
  nativeJobPhotoTruncatedNotice,
} = await import("@/lib/native-field");
const {
  NATIVE_JOB_PHOTO_JSON_MAX_BYTES,
  NATIVE_STORAGE_NOT_CONFIGURED,
  abortNativeAssignedJobPhoto,
  authorizeNativeAssignedJobPhoto,
  finalizeNativeAssignedJobPhoto,
  parseNativeJobPhotoAuthorizeJson,
  previewNativeAssignedJobPhoto,
} = await import("@/lib/native-field-photos");
const { NATIVE_JOB_NOT_AVAILABLE } = await import("@/lib/native-field-ops");
const { readCappedRequestText } = await import("@/lib/native-session-limits");
const { resolveNativeFieldAccess, signInNativeField } = await import(
  "@/lib/native-session"
);
const { SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE } = await import(
  "@/lib/saas-billing/messages"
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_native_field_photos_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for native-field photo test database.");
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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const photoOpsSrc = readRepo("src/lib/native-field-photos.ts");
const membershipGuardSrc = readRepo("src/lib/exact-active-membership.ts");
const photoLibSrc = readRepo("src/lib/native-field.ts");
const finalizeFnSrc = photoOpsSrc.slice(
  photoOpsSrc.indexOf("export async function finalizeNativeAssignedJobPhoto"),
  photoOpsSrc.indexOf("export async function abortNativeAssignedJobPhoto"),
);
const authorizeRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/photos/authorize/route.ts");
const finalizeRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/photos/finalize/route.ts");
const abortRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/photos/abort/route.ts");
const previewRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/photos/[photoId]/route.ts");
const jobScreenSrc = readRepo("apps/native/src/screens/JobScreen.tsx");
const photosUiSrc = readRepo("apps/native/src/screens/JobPhotosSection.tsx");
const photoRulesSrc = readRepo("apps/native/src/photo-rules.ts");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const serviceSrc = readRepo("src/lib/business-storage/service.ts");

console.log("\nSTATIC — Reuse private storage, caps, and capture/review UI");
check(
  "Native photo writes reuse assigned field-job-photo authorize / persist / abort",
  photoOpsSrc.includes("authorizeAssignedFieldJobPhoto") &&
    photoOpsSrc.includes("persistReadyJobPhoto") &&
    photoOpsSrc.includes("abortAssignedFieldJobPhoto") &&
    photoOpsSrc.includes("finalizeManagedUpload") &&
    photoOpsSrc.includes("nativeAssignedJobWhere") &&
    photoOpsSrc.includes("inspectFieldJobPhotoUpload") &&
    photoLibSrc.includes("authorizePrivateStoredAssetDownload"),
);
check(
  "Finalize locks the assigned Job, rechecks assignment, and recounts before persist",
  photoOpsSrc.includes("lockTenantOwnedJob") &&
    photoOpsSrc.includes("assignmentStillHeld") &&
    photoOpsSrc.includes("exactActiveMembershipHeld") &&
    photoOpsSrc.includes("afterInitialRead") &&
    photoOpsSrc.includes("tx.jobPhoto.count") &&
    photoOpsSrc.includes("NATIVE_JOB_PHOTO_LIMIT") &&
    finalizeFnSrc.indexOf("lockTenantOwnedJob") <
      finalizeFnSrc.indexOf("exactActiveMembershipHeld") &&
    finalizeFnSrc.indexOf("exactActiveMembershipHeld") <
      finalizeFnSrc.indexOf("persistReadyJobPhoto") &&
    membershipGuardSrc.includes('FROM "Membership"') &&
    membershipGuardSrc.includes("FOR UPDATE") &&
    !membershipGuardSrc.includes("userId"),
);
check(
  "Refused finalize discards only this job's unattached private field-job-photo",
  photoOpsSrc.includes("discardReadyManagedUpload") &&
    photoOpsSrc.includes("releaseUnpersistedFinalizedPhoto") &&
    photoOpsSrc.includes("FIELD_JOB_PHOTO_PURPOSE") &&
    photoOpsSrc.includes('purpose !== FIELD_JOB_PHOTO_PURPOSE') &&
    (photoOpsSrc.split("releaseUnpersistedFinalizedPhoto").length - 1) === 2 &&
    serviceSrc.includes("export async function discardReadyManagedUpload") &&
    serviceSrc.includes("jobId: match.jobId") &&
    serviceSrc.includes("category: match.category") &&
    serviceSrc.includes("purpose: match.purpose") &&
    serviceSrc.includes("storageUsedBytes: { decrement: existing.fileSizeBytes }"),
);
check(
  "Native photo routes never accept a File body or Vercel Blob helper",
  !authorizeRouteSrc.includes("uploadJobPhoto") &&
    !finalizeRouteSrc.includes("uploadJobPhoto") &&
    !authorizeRouteSrc.includes("instanceof File") &&
    !finalizeRouteSrc.includes("formData.get") &&
    authorizeRouteSrc.includes("readCappedRequestText") &&
    finalizeRouteSrc.includes("readCappedRequestText") &&
    abortRouteSrc.includes("readCappedRequestText") &&
    previewRouteSrc.includes("previewNativeAssignedJobPhoto"),
);
check(
  "Native photo JSON is capped before parse",
  photoOpsSrc.includes("NATIVE_JOB_PHOTO_JSON_MAX_BYTES = 4096") &&
    NATIVE_JOB_PHOTO_JSON_MAX_BYTES === 4096,
);
check(
  "Per-job photo cap is 12 and listing uses take limit+1 then slice",
  NATIVE_JOB_PHOTO_LIMIT === 12 &&
    photoLibSrc.includes("NATIVE_JOB_PHOTO_LIMIT + 1") &&
    photoLibSrc.includes("rows.slice(0, NATIVE_JOB_PHOTO_LIMIT)"),
);
check(
  "Native Job screen captures, reviews, and uploads without a WebView",
  jobScreenSrc.includes("JobPhotosSection") &&
    photosUiSrc.includes("expo-image-picker") &&
    photosUiSrc.includes("launchCameraAsync") &&
    photosUiSrc.includes("Review photo") &&
    photosUiSrc.includes("Upload photo") &&
    photosUiSrc.includes("inspectNativeJobPhoto") &&
    photosUiSrc.includes("authorizeNativeJobPhoto") &&
    photosUiSrc.includes("finalizeNativeJobPhoto") &&
    photosUiSrc.includes("abortNativeJobPhoto") &&
    !photosUiSrc.includes("WebView"),
);
check(
  "Client inspect uses the same 12 MB JPEG/PNG/WebP/HEIC errors as storage",
  photoRulesSrc.includes("NATIVE_JOB_PHOTO_MAX_BYTES = 12 * 1024 * 1024") &&
    photoRulesSrc.includes("Unsupported file type. Choose a JPEG, PNG, WebP, or HEIC photo.") &&
    photoRulesSrc.includes("That photo is too large. The limit is") &&
    FIELD_JOB_PHOTO_MAX_BYTES === 12 * 1024 * 1024,
);
check(
  "Docs describe assignment-scoped photo capture and the dedicated photo check",
  docsSrc.includes("Job photos") &&
    docsSrc.includes("test:native-field-photos") &&
    docsSrc.includes("NATIVE_JOB_PHOTO_LIMIT"),
);

const oversizedAuthorize = parseNativeJobPhotoAuthorizeJson(
  JSON.stringify({
    originalFilename: "huge.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: FIELD_JOB_PHOTO_MAX_BYTES + 1,
  }),
);
const pdfAuthorize = parseNativeJobPhotoAuthorizeJson(
  JSON.stringify({
    originalFilename: "notes.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: 1000,
  }),
);
check(
  "Oversize authorize JSON is rejected with the 12 MB error before storage",
  oversizedAuthorize.ok === false &&
    oversizedAuthorize.status === 400 &&
    oversizedAuthorize.error.includes("too large") &&
    oversizedAuthorize.error.includes("12 MB"),
);
check(
  "Unsupported MIME authorize JSON is rejected with a clear type error",
  pdfAuthorize.ok === false &&
    pdfAuthorize.status === 400 &&
    pdfAuthorize.error.includes("Unsupported file type"),
);

const oversizedBody = await readCappedRequestText(
  new Request("http://native.test/api/native/v1/jobs/job/photos/authorize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(NATIVE_JOB_PHOTO_JSON_MAX_BYTES + 1),
  }),
  NATIVE_JOB_PHOTO_JSON_MAX_BYTES,
);
check(
  "Oversized photo JSON body is rejected before parse",
  oversizedBody.ok === false && oversizedBody.status === 413,
);

try {
  const onboardingDone = new Date();
  const completedOnboarding = {
    firstRunSetupCompletedAt: onboardingDone,
    starterServicesSetupCompletedAt: onboardingDone,
    starterServicesSetupChoice: "SKIPPED",
    websiteSetupCompletedAt: onboardingDone,
    websiteSetupChoice: "SKIPPED",
  };
  const password = "native-photo-pass-9";
  const passwordHash = await hashPassword(password);

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Native Photos",
      slug: `alpha-native-photos-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      ...completedOnboarding,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Native Photos",
      slug: `beta-native-photos-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      ...completedOnboarding,
    },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `mia-${randomUUID()}@native-photos.example`, passwordHash },
  });
  const otherUser = await prisma.user.create({
    data: { name: "Max Other", email: `max-${randomUUID()}@native-photos.example`, passwordHash },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bree Beta", email: `bree-${randomUUID()}@beta-photos.example`, passwordHash },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const otherMem = await prisma.membership.create({
    data: { userId: otherUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "MEMBER" },
  });
  const customerA = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Cara Canary Native Photos",
      phone: "555-0100",
      email: "hidden-customer@native-photos.example",
    },
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
      status: "IN_PROGRESS",
      assignedMembershipId: memberMem.id,
    },
  });
  const otherJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "IN_PROGRESS",
      assignedMembershipId: otherMem.id,
    },
  });
  const betaJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      projectToken: randomUUID(),
      status: "IN_PROGRESS",
      assignedMembershipId: betaMem.id,
    },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessA.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessB.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });

  const memberSignIn = await signInNativeField(prisma, {
    email: memberUser.email,
    password,
  });
  const otherSignIn = await signInNativeField(prisma, {
    email: otherUser.email,
    password,
  });
  const betaSignIn = await signInNativeField(prisma, {
    email: betaUser.email,
    password,
  });
  check("Assigned worker can sign in", memberSignIn.ok === true);
  check("Other worker can sign in", otherSignIn.ok === true);
  check("Foreign-business worker can sign in", betaSignIn.ok === true);
  if (!memberSignIn.ok || !otherSignIn.ok || !betaSignIn.ok) {
    throw new Error("Native photo fixture sign-in failed.");
  }

  const memberAccess = await resolveNativeFieldAccess(prisma, { token: memberSignIn.token });
  const otherAccess = await resolveNativeFieldAccess(prisma, { token: otherSignIn.token });
  const betaAccess = await resolveNativeFieldAccess(prisma, { token: betaSignIn.token });
  check("Assigned worker bearer resolves", memberAccess.ok === true);
  check("Other worker bearer resolves", otherAccess.ok === true);
  check("Foreign-business bearer resolves", betaAccess.ok === true);
  if (!memberAccess.ok || !otherAccess.ok || !betaAccess.ok) {
    throw new Error("Native photo fixture access failed.");
  }

  const provider = new MemoryStorageProvider();
  const storage = {
    provider,
    bucketName: "tbbt-native-photos-test",
    defaultLimitBytes: 50 * 1024 * 1024,
  };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3, 4]);

  console.log("\nDB — Assigned worker upload, review payload, and isolation");

  const unconfigured = await authorizeNativeAssignedJobPhoto(
    prisma,
    memberAccess.access,
    assignedJob.id,
    { originalFilename: "phone.jpg", mimeType: "image/jpeg", fileSizeBytes: jpeg.byteLength },
  );
  check(
    "Missing storage configuration returns a clear operational error",
    unconfigured.ok === false &&
      unconfigured.status === 503 &&
      unconfigured.error === NATIVE_STORAGE_NOT_CONFIGURED,
  );

  const authorized = await authorizeNativeAssignedJobPhoto(
    prisma,
    memberAccess.access,
    assignedJob.id,
    { originalFilename: "phone.jpg", mimeType: "image/jpeg", fileSizeBytes: jpeg.byteLength },
    storage,
  );
  check(
    "Assigned worker can authorize a private upload for their job",
    authorized.ok === true &&
      authorized.uploadMethod === "PUT" &&
      Boolean(authorized.assetId) &&
      Boolean(authorized.uploadUrl),
  );
  if (!authorized.ok) {
    throw new Error("Expected assigned worker authorize to succeed.");
  }

  const pendingAsset = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: authorized.assetId },
  });
  check(
    "Authorized asset is a private JOB_PHOTO on the assigned job",
    pendingAsset.businessId === businessA.id &&
      pendingAsset.jobId === assignedJob.id &&
      pendingAsset.category === "JOB_PHOTO" &&
      pendingAsset.visibility === "PRIVATE" &&
      pendingAsset.status === "PENDING" &&
      pendingAsset.publicPath == null,
  );

  const otherAuthorizeAssigned = await authorizeNativeAssignedJobPhoto(
    prisma,
    otherAccess.access,
    assignedJob.id,
    { originalFilename: "steal.jpg", mimeType: "image/jpeg", fileSizeBytes: jpeg.byteLength },
    storage,
  );
  const betaAuthorizeAssigned = await authorizeNativeAssignedJobPhoto(
    prisma,
    betaAccess.access,
    assignedJob.id,
    { originalFilename: "cross.jpg", mimeType: "image/jpeg", fileSizeBytes: jpeg.byteLength },
    storage,
  );
  check(
    "Another worker cannot authorize an upload on this job",
    otherAuthorizeAssigned.ok === false &&
      otherAuthorizeAssigned.status === 404 &&
      otherAuthorizeAssigned.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Another business cannot authorize an upload on this job",
    betaAuthorizeAssigned.ok === false &&
      betaAuthorizeAssigned.status === 404 &&
      betaAuthorizeAssigned.error === NATIVE_JOB_NOT_AVAILABLE,
  );

  await provider.putObject({
    bucket: pendingAsset.storageAccountId
      ? (await prisma.businessStorageAccount.findUniqueOrThrow({
          where: { id: pendingAsset.storageAccountId },
        })).bucketName
      : storage.bucketName,
    key: pendingAsset.storageKey,
    body: jpeg,
    contentType: "image/jpeg",
  });

  const otherFinalize = await finalizeNativeAssignedJobPhoto(
    prisma,
    otherAccess.access,
    assignedJob.id,
    { assetId: authorized.assetId, stage: "BEFORE" },
    storage,
  );
  const betaFinalize = await finalizeNativeAssignedJobPhoto(
    prisma,
    betaAccess.access,
    assignedJob.id,
    { assetId: authorized.assetId, stage: "BEFORE" },
    storage,
  );
  check(
    "Another worker cannot finalize the assigned worker's pending photo",
    otherFinalize.ok === false && otherFinalize.status === 404,
  );
  check(
    "Another business cannot finalize the assigned worker's pending photo",
    betaFinalize.ok === false && betaFinalize.status === 404,
  );

  const finalized = await finalizeNativeAssignedJobPhoto(
    prisma,
    memberAccess.access,
    assignedJob.id,
    { assetId: authorized.assetId, stage: "BEFORE", caption: "Valve before repair" },
    storage,
  );
  check("Assigned worker can finalize their reviewed photo", finalized.ok === true);
  if (!finalized.ok) {
    throw new Error("Expected assigned worker finalize to succeed.");
  }
  check(
    "Job detail includes the new photo with a short-lived private preview URL",
    finalized.job.photos.items.length === 1 &&
      finalized.job.photos.items[0].caption === "Valve before repair" &&
      finalized.job.photos.items[0].stage === "BEFORE" &&
      finalized.job.photos.items[0].previewUrl ===
        `memory://download/${storage.bucketName}/${pendingAsset.storageKey}` &&
      finalized.job.photos.items[0].previewExpiresInSeconds ===
        PRIVATE_DOWNLOAD_URL_TTL_SECONDS &&
      finalized.job.photos.upload.remaining === NATIVE_JOB_PHOTO_LIMIT - 1 &&
      !JSON.stringify(finalized.job).includes("hidden-customer@native-photos.example"),
  );

  const readyAsset = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: authorized.assetId },
  });
  const accountAfterSuccess = await prisma.businessStorageAccount.findUniqueOrThrow({
    where: { businessId: businessA.id },
  });
  check(
    "Successful finalize keeps a READY asset and charges storage",
    readyAsset.status === "READY" &&
      Number(accountAfterSuccess.storageUsedBytes) === readyAsset.fileSizeBytes &&
      Number(accountAfterSuccess.storageReservedBytes) === 0,
  );

  const duplicateFinalize = await finalizeNativeAssignedJobPhoto(
    prisma,
    memberAccess.access,
    assignedJob.id,
    { assetId: authorized.assetId, stage: "BEFORE", caption: "Valve before repair" },
    storage,
  );
  const photosAfterDuplicate = await prisma.jobPhoto.count({
    where: { jobId: assignedJob.id, businessId: businessA.id },
  });
  const accountAfterDuplicate = await prisma.businessStorageAccount.findUniqueOrThrow({
    where: { businessId: businessA.id },
  });
  check(
    "Duplicate finalize is a successful no-op and does not double-charge storage",
    duplicateFinalize.ok === true &&
      photosAfterDuplicate === 1 &&
      (await prisma.storedAsset.findUniqueOrThrow({ where: { id: authorized.assetId } }))
        .status === "READY" &&
      Number(accountAfterDuplicate.storageUsedBytes) ===
        Number(accountAfterSuccess.storageUsedBytes) &&
      Number(accountAfterDuplicate.storageReservedBytes) === 0,
  );

  const preview = await previewNativeAssignedJobPhoto(
    prisma,
    memberAccess.access,
    assignedJob.id,
    finalized.job.photos.items[0].id,
    storage,
  );
  const otherPreview = await previewNativeAssignedJobPhoto(
    prisma,
    otherAccess.access,
    assignedJob.id,
    finalized.job.photos.items[0].id,
    storage,
  );
  const betaPreview = await previewNativeAssignedJobPhoto(
    prisma,
    betaAccess.access,
    assignedJob.id,
    finalized.job.photos.items[0].id,
    storage,
  );
  const otherJobDetail = await loadNativeAssignedJob(
    prisma,
    otherAccess.access,
    assignedJob.id,
    { storage },
  );
  const betaJobDetail = await loadNativeAssignedJob(
    prisma,
    betaAccess.access,
    assignedJob.id,
    { storage },
  );
  check(
    "Assigned worker can read a private preview URL",
    preview.ok === true &&
      preview.url === `memory://download/${storage.bucketName}/${pendingAsset.storageKey}`,
  );
  check(
    "Another worker cannot read the photo",
    otherPreview.ok === false &&
      otherPreview.status === 404 &&
      otherJobDetail === null,
  );
  check(
    "Another business cannot read the photo",
    betaPreview.ok === false &&
      betaPreview.status === 404 &&
      betaJobDetail === null,
  );

  const otherOwnAuthorize = await authorizeNativeAssignedJobPhoto(
    prisma,
    otherAccess.access,
    otherJob.id,
    { originalFilename: "other.jpg", mimeType: "image/jpeg", fileSizeBytes: jpeg.byteLength },
    storage,
  );
  check("Other worker can still authorize a photo on their own assigned job", otherOwnAuthorize.ok === true);
  if (otherOwnAuthorize.ok) {
    await abortNativeAssignedJobPhoto(
      prisma,
      otherAccess.access,
      otherJob.id,
      { assetId: otherOwnAuthorize.assetId },
      storage,
    );
  }

  const betaOwnAuthorize = await authorizeNativeAssignedJobPhoto(
    prisma,
    betaAccess.access,
    betaJob.id,
    { originalFilename: "beta.jpg", mimeType: "image/jpeg", fileSizeBytes: jpeg.byteLength },
    storage,
  );
  check("Foreign-business worker can still authorize a photo on their own job", betaOwnAuthorize.ok === true);
  if (betaOwnAuthorize.ok) {
    await abortNativeAssignedJobPhoto(
      prisma,
      betaAccess.access,
      betaJob.id,
      { assetId: betaOwnAuthorize.assetId },
      storage,
    );
  }

  async function storageAccounting(businessId) {
    const account = await prisma.businessStorageAccount.findUniqueOrThrow({
      where: { businessId },
    });
    return {
      used: Number(account.storageUsedBytes),
      reserved: Number(account.storageReservedBytes),
    };
  }

  async function authorizeAndStore(access, targetJobId, filename) {
    const authorized = await authorizeNativeAssignedJobPhoto(
      prisma,
      access,
      targetJobId,
      { originalFilename: filename, mimeType: "image/jpeg", fileSizeBytes: jpeg.byteLength },
      storage,
    );
    if (!authorized.ok) return authorized;
    const pending = await prisma.storedAsset.findUniqueOrThrow({
      where: { id: authorized.assetId },
    });
    const account = await prisma.businessStorageAccount.findUniqueOrThrow({
      where: { id: pending.storageAccountId },
    });
    await provider.putObject({
      bucket: account.bucketName,
      key: pending.storageKey,
      body: jpeg,
      contentType: "image/jpeg",
    });
    return authorized;
  }

  console.log("\nDB — Cleanup cannot touch another job or category READY asset");

  const otherJobStored = await authorizeAndStore(
    otherAccess.access,
    otherJob.id,
    "other-ready.jpg",
  );
  check("Other worker can store a READY photo on their own job", otherJobStored.ok === true);
  if (!otherJobStored.ok) {
    throw new Error("Expected other-job authorize to succeed.");
  }
  const otherJobFinalized = await finalizeNativeAssignedJobPhoto(
    prisma,
    otherAccess.access,
    otherJob.id,
    { assetId: otherJobStored.assetId, stage: "BEFORE" },
    storage,
  );
  check("Other worker can finalize a photo on their own job", otherJobFinalized.ok === true);
  if (!otherJobFinalized.ok) {
    throw new Error("Expected other-job finalize to succeed.");
  }

  const foreignDeps = {
    db: prisma,
    provider,
    bucketName: storage.bucketName,
    defaultLimitBytes: storage.defaultLimitBytes,
  };
  const otherCategoryAuth = await authorizeManagedUpload(foreignDeps, businessA.id, {
    category: "DOCUMENT",
    purpose: "invoice-packet",
    originalFilename: "packet.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: jpeg.byteLength,
    visibility: "PRIVATE",
  });
  await provider.putObject({
    bucket: otherCategoryAuth.account.bucketName,
    key: otherCategoryAuth.asset.storageKey,
    body: jpeg,
    contentType: "application/pdf",
  });
  const otherCategoryReady = await finalizeManagedUpload(
    foreignDeps,
    businessA.id,
    otherCategoryAuth.asset.id,
  );
  check(
    "Another-category READY asset is charged before the steal attempt",
    otherCategoryReady.status === "READY" &&
      otherCategoryReady.category === "DOCUMENT" &&
      otherCategoryReady.jobId == null,
  );

  const beforeForeignCleanup = await storageAccounting(businessA.id);
  const stealOtherJob = await finalizeNativeAssignedJobPhoto(
    prisma,
    memberAccess.access,
    assignedJob.id,
    { assetId: otherJobStored.assetId, stage: "AFTER" },
    storage,
  );
  const stealOtherCategory = await finalizeNativeAssignedJobPhoto(
    prisma,
    memberAccess.access,
    assignedJob.id,
    { assetId: otherCategoryReady.id, stage: "AFTER" },
    storage,
  );
  const afterForeignCleanup = await storageAccounting(businessA.id);
  const otherJobAssetAfter = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: otherJobStored.assetId },
  });
  const otherCategoryAfter = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: otherCategoryReady.id },
  });
  const otherJobPhotoAfter = await prisma.jobPhoto.findFirst({
    where: { storedAssetId: otherJobStored.assetId, businessId: businessA.id },
  });
  check(
    "Another job's READY asset ID cannot be deleted or uncharged",
    stealOtherJob.ok === false &&
      stealOtherJob.status === 400 &&
      otherJobAssetAfter.status === "READY" &&
      otherJobPhotoAfter != null &&
      afterForeignCleanup.used === beforeForeignCleanup.used &&
      afterForeignCleanup.reserved === beforeForeignCleanup.reserved,
  );
  check(
    "Another category's READY asset ID cannot be deleted or uncharged",
    stealOtherCategory.ok === false &&
      stealOtherCategory.status === 400 &&
      otherCategoryAfter.status === "READY" &&
      otherCategoryAfter.category === "DOCUMENT" &&
      afterForeignCleanup.used === beforeForeignCleanup.used &&
      afterForeignCleanup.reserved === beforeForeignCleanup.reserved,
  );

  console.log("\nDB — Concurrent finalize cap and reassignment race");
  const beforeConcurrent = await storageAccounting(businessA.id);

  const concurrentJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "IN_PROGRESS",
      assignedMembershipId: memberMem.id,
    },
  });
  for (let index = 0; index < NATIVE_JOB_PHOTO_LIMIT - 1; index += 1) {
    await prisma.jobPhoto.create({
      data: {
        businessId: businessA.id,
        jobId: concurrentJob.id,
        stage: "DURING",
        url: `https://example.blob.vercel-storage.com/race-filler-${index}.jpg`,
      },
    });
  }
  const concurrentA = await authorizeAndStore(
    memberAccess.access,
    concurrentJob.id,
    "race-a.jpg",
  );
  const concurrentB = await authorizeAndStore(
    memberAccess.access,
    concurrentJob.id,
    "race-b.jpg",
  );
  check(
    "Two in-flight uploads can be authorized when 11 photos already exist",
    concurrentA.ok === true && concurrentB.ok === true,
  );
  if (!concurrentA.ok || !concurrentB.ok) {
    throw new Error("Expected both concurrent authorizes to succeed.");
  }
  const [raceFinalizeA, raceFinalizeB] = await Promise.all([
    finalizeNativeAssignedJobPhoto(
      prisma,
      memberAccess.access,
      concurrentJob.id,
      { assetId: concurrentA.assetId, stage: "AFTER" },
      storage,
    ),
    finalizeNativeAssignedJobPhoto(
      prisma,
      memberAccess.access,
      concurrentJob.id,
      { assetId: concurrentB.assetId, stage: "AFTER" },
      storage,
    ),
  ]);
  const concurrentCount = await prisma.jobPhoto.count({
    where: { jobId: concurrentJob.id, businessId: businessA.id },
  });
  const concurrentSuccesses = [raceFinalizeA, raceFinalizeB].filter((row) => row.ok).length;
  const concurrentRejected = [raceFinalizeA, raceFinalizeB].filter(
    (row) => row.ok === false && row.status === 409,
  );
  const winningAssetId = raceFinalizeA.ok ? concurrentA.assetId : concurrentB.assetId;
  const losingAssetId = raceFinalizeA.ok ? concurrentB.assetId : concurrentA.assetId;
  const winningAsset = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: winningAssetId },
  });
  const losingAsset = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: losingAssetId },
  });
  const losingPhoto = await prisma.jobPhoto.findFirst({
    where: { storedAssetId: losingAssetId, businessId: businessA.id },
  });
  const afterRace = await storageAccounting(businessA.id);
  const readyUsed = (
    await prisma.storedAsset.aggregate({
      where: { businessId: businessA.id, status: "READY" },
      _sum: { fileSizeBytes: true },
    })
  )._sum.fileSizeBytes ?? 0;
  check(
    "Simultaneous finalizes cannot create more than 12 job photos",
    concurrentCount === NATIVE_JOB_PHOTO_LIMIT &&
      concurrentSuccesses === 1 &&
      concurrentRejected.length === 1 &&
      concurrentRejected[0].error === nativeJobPhotoTooManyMessage(),
  );
  check(
    "Race loser is not READY and its bytes are not charged",
    losingAsset.status === "FAILED" &&
      losingPhoto == null &&
      winningAsset.status === "READY" &&
      afterRace.used === Number(readyUsed) &&
      afterRace.reserved === 0 &&
      afterRace.used === beforeConcurrent.used + winningAsset.fileSizeBytes,
  );

  const reassignJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "IN_PROGRESS",
      assignedMembershipId: memberMem.id,
    },
  });
  const beforeReassign = await storageAccounting(businessA.id);
  const reassignAuth = await authorizeAndStore(
    memberAccess.access,
    reassignJob.id,
    "reassign.jpg",
  );
  check("Former worker can authorize before reassignment", reassignAuth.ok === true);
  if (!reassignAuth.ok) {
    throw new Error("Expected reassignment authorize to succeed.");
  }
  const photosBeforeReassign = await prisma.jobPhoto.count({
    where: { jobId: reassignJob.id, businessId: businessA.id },
  });
  const reassignFinalize = await finalizeNativeAssignedJobPhoto(
    prisma,
    memberAccess.access,
    reassignJob.id,
    { assetId: reassignAuth.assetId, stage: "BEFORE" },
    storage,
    {
      afterInitialRead: async () => {
        await prisma.job.update({
          where: { id: reassignJob.id },
          data: { assignedMembershipId: otherMem.id },
        });
      },
    },
  );
  const reassignAfter = await prisma.job.findFirst({
    where: { id: reassignJob.id, businessId: businessA.id },
    select: { assignedMembershipId: true },
  });
  const photosAfterReassign = await prisma.jobPhoto.count({
    where: { jobId: reassignJob.id, businessId: businessA.id },
  });
  const reassignPhoto = await prisma.jobPhoto.findFirst({
    where: { storedAssetId: reassignAuth.assetId, businessId: businessA.id },
  });
  const reassignAsset = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: reassignAuth.assetId },
  });
  const afterReassign = await storageAccounting(businessA.id);
  const readyUsedAfterReassign = (
    await prisma.storedAsset.aggregate({
      where: { businessId: businessA.id, status: "READY" },
      _sum: { fileSizeBytes: true },
    })
  )._sum.fileSizeBytes ?? 0;
  check(
    "Reassignment after the authorize read refuses finalize and creates no photo",
    reassignFinalize.ok === false &&
      reassignFinalize.status === 404 &&
      reassignFinalize.error === NATIVE_JOB_NOT_AVAILABLE &&
      reassignAfter?.assignedMembershipId === otherMem.id &&
      photosAfterReassign === photosBeforeReassign &&
      reassignPhoto == null,
  );
  check(
    "Locked assignment refusal leaves no READY orphan or charged storage",
    reassignAsset.status === "FAILED" &&
      afterReassign.used === beforeReassign.used &&
      afterReassign.reserved === beforeReassign.reserved &&
      afterReassign.used === Number(readyUsedAfterReassign),
  );

  const deactivateUser = await prisma.user.create({
    data: {
      name: "Deactivate Photo Worker",
      email: `deactivate-${randomUUID()}@native-photos.example`,
      passwordHash,
    },
  });
  const deactivateMem = await prisma.membership.create({
    data: { userId: deactivateUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const deactivateSignIn = await signInNativeField(prisma, {
    email: deactivateUser.email,
    password,
  });
  if (!deactivateSignIn.ok) {
    throw new Error("Deactivation photo fixture sign-in failed.");
  }
  const deactivateAccess = await resolveNativeFieldAccess(prisma, {
    token: deactivateSignIn.token,
  });
  if (!deactivateAccess.ok) {
    throw new Error("Deactivation photo fixture access failed.");
  }
  const deactivateJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "IN_PROGRESS",
      assignedMembershipId: deactivateMem.id,
    },
  });
  const beforeDeactivate = await storageAccounting(businessA.id);
  const deactivateAuth = await authorizeAndStore(
    deactivateAccess.access,
    deactivateJob.id,
    "deactivate.jpg",
  );
  check("Worker can authorize a photo before membership deactivation", deactivateAuth.ok === true);
  if (!deactivateAuth.ok) {
    throw new Error("Expected deactivation authorize to succeed.");
  }
  const photosBeforeDeactivate = await prisma.jobPhoto.count({
    where: { jobId: deactivateJob.id, businessId: businessA.id },
  });
  const deactivateFinalize = await finalizeNativeAssignedJobPhoto(
    prisma,
    deactivateAccess.access,
    deactivateJob.id,
    { assetId: deactivateAuth.assetId, stage: "BEFORE" },
    storage,
    {
      afterInitialRead: async () => {
        const otherClient = new PrismaClient({ datasourceUrl: testUrl });
        try {
          await otherClient.membership.update({
            where: { id: deactivateMem.id },
            data: { active: false },
          });
        } finally {
          await otherClient.$disconnect();
        }
      },
    },
  );
  const deactivateJobAfter = await prisma.job.findFirst({
    where: { id: deactivateJob.id, businessId: businessA.id },
    select: { assignedMembershipId: true },
  });
  const photosAfterDeactivate = await prisma.jobPhoto.count({
    where: { jobId: deactivateJob.id, businessId: businessA.id },
  });
  const deactivatePhoto = await prisma.jobPhoto.findFirst({
    where: { storedAssetId: deactivateAuth.assetId, businessId: businessA.id },
  });
  const deactivateAsset = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: deactivateAuth.assetId },
  });
  const afterDeactivate = await storageAccounting(businessA.id);
  check(
    "Deactivated membership after the initial read refuses finalize and creates no photo",
    deactivateFinalize.ok === false &&
      deactivateFinalize.status === 404 &&
      deactivateFinalize.error === NATIVE_JOB_NOT_AVAILABLE &&
      deactivateJobAfter?.assignedMembershipId === deactivateMem.id &&
      photosAfterDeactivate === photosBeforeDeactivate &&
      deactivatePhoto == null,
  );
  check(
    "Deactivated finalize leaves no READY orphan or charged storage",
    deactivateAsset.status === "FAILED" &&
      afterDeactivate.used === beforeDeactivate.used &&
      afterDeactivate.reserved === beforeDeactivate.reserved,
  );

  const gapJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "IN_PROGRESS",
      assignedMembershipId: memberMem.id,
    },
  });
  const gapAuth = await authorizeAndStore(memberAccess.access, gapJob.id, "gap.jpg");
  check("Former worker can authorize before a mid-flight reassignment", gapAuth.ok === true);
  if (!gapAuth.ok) {
    throw new Error("Expected gap authorize to succeed.");
  }
  await prisma.job.update({
    where: { id: gapJob.id },
    data: { assignedMembershipId: otherMem.id },
  });
  const gapFinalize = await finalizeNativeAssignedJobPhoto(
    prisma,
    memberAccess.access,
    gapJob.id,
    { assetId: gapAuth.assetId, stage: "BEFORE" },
    storage,
  );
  const gapPhoto = await prisma.jobPhoto.findFirst({
    where: { storedAssetId: gapAuth.assetId, businessId: businessA.id },
  });
  check(
    "Reassignment between authorize and finalize creates no photo for the former worker",
    gapFinalize.ok === false &&
      gapFinalize.status === 404 &&
      gapPhoto == null,
  );

  console.log("\nDB — Caps, clear errors, and listing truncation");

  const oversize = await authorizeNativeAssignedJobPhoto(
    prisma,
    memberAccess.access,
    assignedJob.id,
    {
      originalFilename: "huge.jpg",
      mimeType: "image/jpeg",
      fileSizeBytes: FIELD_JOB_PHOTO_MAX_BYTES + 1,
    },
    storage,
  );
  const badType = await authorizeNativeAssignedJobPhoto(
    prisma,
    memberAccess.access,
    assignedJob.id,
    {
      originalFilename: "notes.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 1000,
    },
    storage,
  );
  check(
    "Oversize upload is refused with the 12 MB error",
    oversize.ok === false &&
      oversize.status === 400 &&
      oversize.error.includes("too large") &&
      oversize.error.includes("12 MB"),
  );
  check(
    "Unsupported type is refused with a clear file-type error",
    badType.ok === false &&
      badType.status === 400 &&
      badType.error.includes("Unsupported file type"),
  );

  for (let index = 0; index < NATIVE_JOB_PHOTO_LIMIT - 1; index += 1) {
    await prisma.jobPhoto.create({
      data: {
        businessId: businessA.id,
        jobId: assignedJob.id,
        stage: "DURING",
        url: `https://example.blob.vercel-storage.com/filler-${index}.jpg`,
      },
    });
  }
  const atCap = await authorizeNativeAssignedJobPhoto(
    prisma,
    memberAccess.access,
    assignedJob.id,
    { originalFilename: "thirteenth.jpg", mimeType: "image/jpeg", fileSizeBytes: jpeg.byteLength },
    storage,
  );
  check(
    "Thirteenth photo is refused with the field capture limit error",
    atCap.ok === false &&
      atCap.status === 409 &&
      atCap.error === nativeJobPhotoTooManyMessage(),
  );

  await prisma.jobPhoto.create({
    data: {
      businessId: businessA.id,
      jobId: assignedJob.id,
      stage: "AFTER",
      url: "https://example.blob.vercel-storage.com/overflow.jpg",
    },
  });
  const listed = await loadNativeAssignedJob(prisma, memberAccess.access, assignedJob.id, {
    storage,
  });
  check(
    "Job photo listing is hard-capped and advertises truncation",
    listed?.photos.count === NATIVE_JOB_PHOTO_LIMIT + 1 &&
      listed.photos.items.length === NATIVE_JOB_PHOTO_LIMIT &&
      listed.photos.truncated === true &&
      listed.photos.truncatedNotice === nativeJobPhotoTruncatedNotice() &&
      listed.photos.upload.available === false &&
      listed.photos.upload.reason === nativeJobPhotoTooManyMessage(),
  );

  const blockedBusiness = await prisma.business.create({
    data: {
      name: "Blocked Native Photos",
      slug: `blocked-native-photos-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      ...completedOnboarding,
    },
  });
  const blockedUser = await prisma.user.create({
    data: {
      name: "No Sub Member",
      email: `nosub-${randomUUID()}@blocked-photos.example`,
      passwordHash,
    },
  });
  const blockedMem = await prisma.membership.create({
    data: { userId: blockedUser.id, businessId: blockedBusiness.id, role: "MEMBER" },
  });
  const blockedJob = await prisma.job.create({
    data: {
      businessId: blockedBusiness.id,
      projectToken: randomUUID(),
      status: "IN_PROGRESS",
      assignedMembershipId: blockedMem.id,
    },
  });
  const endedTrial = new Date(Date.now() - 60_000);
  await prisma.businessSaasSubscription.create({
    data: {
      businessId: blockedBusiness.id,
      status: "canceled",
      planCode: "FOUNDER",
      legacyExempt: false,
      trialStartedAt: new Date(endedTrial.getTime() - 14 * 24 * 60 * 60 * 1000),
      trialEndsAt: endedTrial,
      founderEligibilityEndedAt: endedTrial,
    },
  });
  const blockedSignIn = await signInNativeField(prisma, {
    email: blockedUser.email,
    password,
  });
  check("Unsubscribed worker can sign in", blockedSignIn.ok === true);
  if (blockedSignIn.ok) {
    const blockedAccess = await resolveNativeFieldAccess(prisma, {
      token: blockedSignIn.token,
    });
    if (blockedAccess.ok) {
      const blockedWrite = await authorizeNativeAssignedJobPhoto(
        prisma,
        blockedAccess.access,
        blockedJob.id,
        { originalFilename: "blocked.jpg", mimeType: "image/jpeg", fileSizeBytes: jpeg.byteLength },
        storage,
      );
      check(
        "Photo writes require an operating SaaS subscription",
        blockedWrite.ok === false &&
          blockedWrite.status === 403 &&
          blockedWrite.error === SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
      );
    } else {
      check("Photo writes require an operating SaaS subscription", false);
    }
  }

  const bPhotos = await prisma.jobPhoto.count({ where: { businessId: businessB.id } });
  const bReady = await prisma.storedAsset.count({
    where: { businessId: businessB.id, status: "READY" },
  });
  const bOnAlphaJob = await prisma.storedAsset.count({
    where: { businessId: businessB.id, jobId: assignedJob.id },
  });
  check(
    "Business B has no ready photo and no asset on Business A's job",
    bPhotos === 0 && bReady === 0 && bOnAlphaJob === 0,
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

if (failures > 0) {
  console.error(`\n${failures} native field photo check(s) failed.`);
  process.exit(1);
}
console.log(
  "\nNative field photo checks passed: assigned capture/review, private storage reuse, isolation, and upload caps held.",
);

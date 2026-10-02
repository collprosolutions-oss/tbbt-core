/**
 * Tenant-isolated business storage + Website Photos R2 cutover.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-business-storage.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, CAPABILITIES, requireBusinessCapability } = await import(
  "@/lib/authorization"
);
const { assertSettingsBusinessScope } = await import("@/lib/settings-ops");
const {
  DEFAULT_MANAGED_STORAGE_LIMIT_BYTES,
  MemoryStorageProvider,
  StorageAccessError,
  StorageError,
  StorageQuotaError,
  assertKeyBelongsToBusiness,
  buildBusinessStorageKey,
  businessNamespacePrefix,
  formatStorageBytes,
  hasEnoughStorage,
  isManagedPublicAssetPath,
  publicAssetPath,
} = await import("@/lib/business-storage/index");
const {
  abortBusinessUpload,
  abortManagedUpload,
  authorizeBusinessUpload,
  authorizeManagedUpload,
  deleteStoredAsset,
  discardReadyManagedUpload,
  ensureBusinessStorageAccount,
  finalizeBusinessUpload,
  finalizeManagedUpload,
  managedStorageWriteTestHooks,
  putBusinessObject,
  readPublicStoredAsset,
} = await import("@/lib/business-storage/service");
const { servePublicStoredAsset } = await import("@/lib/business-storage/public-serve");
const {
  authorizeWebsitePhotoUploadOp,
  finalizeWebsitePhotoUploadOp,
  inspectWebsitePhotoUpload,
  replaceWebsitePhotoFromBytes,
} = await import("@/lib/business-storage/website-photos");
const {
  PUBLIC_SITE_HOME_PAGE,
  PUBLIC_SITE_HERO_SLOT,
  buildPublicHomeImagePresentation,
  categoryImageSlot,
  clampObjectZoom,
} = await import("@/lib/public-site-images");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_business_storage_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for business storage test database.");
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

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function trackDeletes(inner, options = {}) {
  const deletes = [];
  const failOnKeys = new Set(options.failOnKeys ?? []);
  const failAll = Boolean(options.failAll);
  return {
    deletes,
    provider: {
      get id() {
        return inner.id;
      },
      putObject: (input) => inner.putObject(input),
      getObjectMetadata: (input) => inner.getObjectMetadata(input),
      getObject: (input) => inner.getObject(input),
      objectExists: (input) => inner.objectExists(input),
      createUploadUrl: (input) => inner.createUploadUrl(input),
      createDownloadUrl: (input) => inner.createDownloadUrl(input),
      async deleteObject(input) {
        deletes.push({ bucket: input.bucket, key: input.key });
        if (failAll || failOnKeys.has(input.key)) {
          throw new Error("simulated provider deleteObject failure");
        }
        return inner.deleteObject(input);
      },
    },
  };
}

async function accountSnapshot(businessId) {
  const account = await prisma.businessStorageAccount.findUniqueOrThrow({
    where: { businessId },
  });
  return {
    used: Number(account.storageUsedBytes),
    reserved: Number(account.storageReservedBytes),
  };
}

function createCommitBarrier() {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let arrived;
  const waiting = new Promise((resolve) => {
    arrived = resolve;
  });
  return {
    wait: async () => {
      arrived();
      await held;
    },
    arrived: waiting,
    release: () => release(),
  };
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

function discardMatchFor(asset) {
  return {
    jobId: asset.jobId,
    category: asset.category,
    purpose: asset.purpose,
    visibility: asset.visibility,
  };
}

const editorSrc = readRepo("src/components/settings/website-photos-editor.tsx");
const actionSrc = readRepo("src/app/actions/public-site-images.ts");
const storageSrc = readRepo("src/lib/storage.ts");

console.log("\nSTATIC — Storage boundary");
check("Website Photos authorize through the storage service",
  editorSrc.includes("authorizeWebsitePhotoUpload") &&
    editorSrc.includes("finalizeWebsitePhotoUpload") &&
    editorSrc.includes("abortWebsitePhotoUpload"));
check("Website Photos no longer require Vercel Blob",
  actionSrc.includes("isBusinessStorageConfigured") &&
    !actionSrc.includes("BLOB_READ_WRITE_TOKEN") &&
    !actionSrc.includes("uploadPublicSitePhoto"));
check("Owner job-photo helper still exists for historical Blob uploads",
  storageSrc.includes("uploadJobPhoto"));
const fieldJobPhotoSrc = readRepo("src/lib/business-storage/field-job-photos.ts");
const fieldJobActionSrc = readRepo("src/app/actions/field-job.ts");
check("Field job photos reuse private R2 authorize/PUT/finalize",
  fieldJobPhotoSrc.includes("authorizeManagedUpload") &&
    fieldJobPhotoSrc.includes('category: "JOB_PHOTO"') &&
    fieldJobPhotoSrc.includes('visibility: "PRIVATE"') &&
    fieldJobActionSrc.includes("authorizeAssignedFieldJobPhoto") &&
    !fieldJobActionSrc.includes("uploadJobPhoto"));
const privateRouteSrc = readRepo("src/app/api/storage/private/[assetId]/route.ts");
const privateServeSrc = readRepo("src/lib/business-storage/private-serve.ts");
check("Private asset reads are role-aware: MEMBER is assignment-scoped, OWNER/ADMIN stay business-wide",
  privateRouteSrc.includes("access.workspace.role") &&
    privateRouteSrc.includes("access.workspace.membership.id") &&
    privateServeSrc.includes("canAccessManagementConsole") &&
    privateServeSrc.includes("assignedMembershipId"));
check("Private asset route redirects to a presigned GET instead of streaming object bytes",
  privateRouteSrc.includes("authorizePrivateStoredAssetDownload") &&
    privateRouteSrc.includes("NextResponse.redirect") &&
    !privateRouteSrc.includes("Buffer.from") &&
    !privateRouteSrc.includes("servePrivateStoredAsset"));
check("Public website assets use an explicit public path",
  isManagedPublicAssetPath("/api/storage/public/asset123") &&
    !isManagedPublicAssetPath("/api/storage/public/../secret"));
const routeSrc = readRepo("src/app/api/storage/public/[assetId]/route.ts");
const r2Src = readRepo("src/lib/business-storage/r2-provider.ts");
check("Public asset route streams READY objects instead of a public-bucket redirect",
  routeSrc.includes("servePublicStoredAsset") &&
    !routeSrc.includes("publicBaseUrl") &&
    !routeSrc.includes("NextResponse.redirect"));
check("R2 client disables default AWS checksums that break GetObject",
  r2Src.includes('requestChecksumCalculation: "WHEN_REQUIRED"') &&
    r2Src.includes('responseChecksumValidation: "WHEN_REQUIRED"'));
check("Browser PutObject uses a narrow exact-origin R2 CORS policy",
  r2Src.includes("ensureR2BrowserUploadCors") &&
    readRepo("src/lib/business-storage/r2-cors.ts").includes("https://www.collproreno.com") &&
    readRepo("src/lib/business-storage/r2-cors.ts").includes("AllowedMethods") &&
    !readRepo("src/lib/business-storage/r2-cors.ts").includes('AllowedOrigins: ["*"]'));
check("Tenant keys always start with the business namespace",
  businessNamespacePrefix("biz_a") === "businesses/biz_a" &&
    buildBusinessStorageKey({
      businessId: "biz_a",
      category: "WEBSITE_IMAGE",
      mimeType: "image/jpeg",
    }).startsWith("businesses/biz_a/website/"));
check("Foreign keys are rejected", (() => {
  try {
    assertKeyBelongsToBusiness("businesses/biz_b/website/x.jpg", "biz_a");
    return false;
  } catch (error) {
    return error instanceof StorageAccessError;
  }
})());
check("Quota math blocks overage and expired-looking leftovers",
  hasEnoughStorage({ usedBytes: 4, reservedBytes: 1, incomingBytes: 1, limitBytes: 6 }) &&
    !hasEnoughStorage({ usedBytes: 4, reservedBytes: 1, incomingBytes: 2, limitBytes: 6 }));
check("Default managed limit is a finite 5 GB technical default",
  DEFAULT_MANAGED_STORAGE_LIMIT_BYTES === 5 * 1024 * 1024 * 1024 &&
    formatStorageBytes(DEFAULT_MANAGED_STORAGE_LIMIT_BYTES).includes("GB"));
check("Invalid website photo types are rejected before authorize",
  inspectWebsitePhotoUpload({ type: "application/pdf", name: "x.pdf", size: 100 }).ok === false &&
    inspectWebsitePhotoUpload({ type: "image/jpeg", name: "hero.jpg", size: 800 }).ok === true);
check("Zoom below 1 is still accepted after the storage cutover",
  clampObjectZoom(0.7) === 0.7);

try {
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-sto-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-sto-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-sto-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Storage", slug: `alpha-sto-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Storage", slug: `beta-sto-${randomUUID()}`, tradeCode: "HANDYMAN" },
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
  await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Door Adjustment",
      category: "Doors & Locks",
      pricingMode: "STARTING_AT",
      price: 75.00,
      active: true,
    },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);
  const provider = new MemoryStorageProvider();
  const deps = {
    db: prisma,
    provider,
    bucketName: "tbbt-managed-test",
    defaultLimitBytes: 5000,
  };

  console.log("\nDB — Isolation, quota, and Website Photos");
  await expectThrow("MEMBER cannot pass the settings storage gate", () => {
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_SETTINGS);
  }, (error) => error instanceof ForbiddenError);
  await expectThrow("Foreign businessId in a storage form is rejected", () => {
    assertSettingsBusinessScope(ownerA, businessB.id);
  }, () => true);

  const accountA = await ensureBusinessStorageAccount(prisma, businessA.id, {
    bucketName: "tbbt-managed-test",
    defaultLimitBytes: 5000,
  });
  check("Managed account is created with a tenant namespace",
    accountA.namespacePrefix === `businesses/${businessA.id}` &&
      accountA.mode === "MANAGED" &&
      accountA.provider === "R2");

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3, 4]);
  const first = await replaceWebsitePhotoFromBytes(deps, ownerA, {
    page: PUBLIC_SITE_HOME_PAGE,
    slot: PUBLIC_SITE_HERO_SLOT,
    originalFilename: "hero.jpg",
    mimeType: "image/jpeg",
    body: jpeg,
  });
  check("Website Photo replacement persists a public stored asset",
    first.saved.imageUrl === publicAssetPath(first.asset.id) &&
      first.asset.visibility === "PUBLIC" &&
      first.asset.status === "READY" &&
      first.saved.objectZoom === 1);

  await prisma.publicSiteImage.update({
    where: { id: first.saved.id },
    data: { objectPosition: "42% 35%", objectZoom: 0.7 },
  });
  const zoomed = await prisma.publicSiteImage.findUniqueOrThrow({ where: { id: first.saved.id } });
  check("Crop metadata stays on the Website Photos row",
    zoomed.objectPosition === "42% 35%" && zoomed.objectZoom === 0.7);

  const second = await replaceWebsitePhotoFromBytes(deps, ownerA, {
    page: PUBLIC_SITE_HOME_PAGE,
    slot: PUBLIC_SITE_HERO_SLOT,
    originalFilename: "hero-2.jpg",
    mimeType: "image/jpeg",
    body: jpeg,
  });
  const afterReplace = await prisma.publicSiteImage.findUniqueOrThrow({ where: { id: second.saved.id } });
  check("Replacing the photo keeps the saved crop",
    afterReplace.objectPosition === "42% 35%" &&
      afterReplace.objectZoom === 0.7 &&
      afterReplace.storedAssetId === second.asset.id);
  const oldAsset = await prisma.storedAsset.findUniqueOrThrow({ where: { id: first.asset.id } });
  check("Replaced website asset is deleted and usage is released",
    oldAsset.status === "DELETED");

  const walls = await replaceWebsitePhotoFromBytes(deps, ownerA, {
    page: PUBLIC_SITE_HOME_PAGE,
    slot: categoryImageSlot("Doors & Locks"),
    originalFilename: "walls.jpg",
    mimeType: "image/jpeg",
    body: jpeg,
  });
  const heroAfterCategory = await prisma.publicSiteImage.findUniqueOrThrow({
    where: { id: afterReplace.id },
  });
  check("One website slot does not affect another",
    walls.saved.slot === "category:Doors & Locks" &&
      heroAfterCategory.storedAssetId === second.asset.id &&
      heroAfterCategory.objectZoom === 0.7);

  const presented = buildPublicHomeImagePresentation(
    [{ category: "Doors & Locks", items: [] }],
    [heroAfterCategory, walls.saved],
  );
  check("Public website image displays the stored public path",
    presented.hero.src === publicAssetPath(second.asset.id) &&
      presented.hero.objectZoom === 0.7);

  const publicAsset = await readPublicStoredAsset(prisma, second.asset.id);
  check("Public website assets are readable without a session",
    publicAsset?.id === second.asset.id && publicAsset.visibility === "PUBLIC");
  const served = await servePublicStoredAsset(prisma, second.asset.id, { provider });
  check("Public /api/storage/public route returns the READY PUBLIC object bytes",
    served.ok === true &&
      served.status === 200 &&
      served.contentType === "image/jpeg" &&
      served.contentLength === jpeg.byteLength &&
      Buffer.from(served.body).equals(jpeg) &&
      presented.hero.src === `/api/storage/public/${second.asset.id}`);
  const missing = await servePublicStoredAsset(prisma, "missing-asset", { provider });
  check("Unknown public asset ids are not served",
    missing.ok === false && missing.status === 404);

  const privateAuth = await authorizeBusinessUpload(deps, ownerA, {
    category: "JOB_PHOTO",
    purpose: "job-private",
    originalFilename: "job.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: jpeg.byteLength,
    visibility: "PRIVATE",
  });
  await provider.putObject({
    bucket: privateAuth.account.bucketName,
    key: privateAuth.asset.storageKey,
    body: jpeg,
    contentType: "image/jpeg",
  });
  const privateAsset = await finalizeBusinessUpload(deps, ownerA, privateAuth.asset.id);
  check("Private job photos do not receive a public path",
    privateAsset.visibility === "PRIVATE" && privateAsset.publicPath == null);
  const leaked = await readPublicStoredAsset(prisma, privateAsset.id);
  check("Private asset is not publicly exposed", leaked == null);
  const privateServed = await servePublicStoredAsset(prisma, privateAsset.id, { provider });
  check("Private objects cannot be read from the public image route",
    privateServed.ok === false && privateServed.status === 404);

  await expectThrow("Business B cannot finalize Business A upload", () =>
    finalizeBusinessUpload(deps, ownerB, second.asset.id),
  (error) => error instanceof StorageAccessError);
  await expectThrow("Business B cannot delete Business A asset", () =>
    deleteStoredAsset(deps, ownerB, second.asset.id),
  (error) => error instanceof StorageAccessError);
  await expectThrow("MEMBER cannot authorize a website upload", () =>
    authorizeWebsitePhotoUploadOp(deps, memberA, {
      page: PUBLIC_SITE_HOME_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      originalFilename: "x.jpg",
      mimeType: "image/jpeg",
      fileSizeBytes: 20,
    }),
  (error) => error instanceof ForbiddenError);

  const reserved = await authorizeBusinessUpload(deps, ownerA, {
    category: "WEBSITE_IMAGE",
    purpose: "orphan",
    originalFilename: "ghost.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 4000,
    visibility: "PUBLIC",
  });
  await expectThrow("Failed finalize does not create fake READY usage", () =>
    finalizeBusinessUpload(deps, ownerA, reserved.asset.id),
  () => true);
  await abortBusinessUpload(deps, ownerA, reserved.asset.id);
  const afterAbort = await prisma.businessStorageAccount.findUniqueOrThrow({
    where: { businessId: businessA.id },
  });
  const readyBytes = (await prisma.storedAsset.aggregate({
    where: { businessId: businessA.id, status: "READY" },
    _sum: { fileSizeBytes: true },
  }))._sum.fileSizeBytes ?? 0;
  check("Aborted upload releases reservation and does not inflate usage",
    Number(afterAbort.storageReservedBytes) === 0 &&
      Number(afterAbort.storageUsedBytes) === readyBytes);

  await expectThrow("Quota blocks an upload that would exceed the entitlement", () =>
    authorizeBusinessUpload(deps, ownerA, {
      category: "WEBSITE_IMAGE",
      purpose: "too-big",
      originalFilename: "huge.jpg",
      mimeType: "image/jpeg",
      fileSizeBytes: 5000,
      visibility: "PUBLIC",
    }),
  (error) => error instanceof StorageQuotaError);

  const usedBeforeDelete = Number(
    (await prisma.businessStorageAccount.findUniqueOrThrow({
      where: { businessId: businessA.id },
    })).storageUsedBytes,
  );
  await deleteStoredAsset(deps, ownerA, walls.asset.id);
  const usedAfterDelete = Number(
    (await prisma.businessStorageAccount.findUniqueOrThrow({
      where: { businessId: businessA.id },
    })).storageUsedBytes,
  );
  check("Delete updates usage downward",
    usedAfterDelete === usedBeforeDelete - walls.asset.fileSizeBytes);

  const bAccount = await prisma.businessStorageAccount.findUnique({
    where: { businessId: businessB.id },
  });
  const bAssets = await prisma.storedAsset.findMany({ where: { businessId: businessB.id } });
  check("Business B stays empty when A uploads", bAccount == null && bAssets.length === 0);

  const listing = await prisma.storedAsset.findMany({
    where: { businessId: businessA.id, status: "READY" },
  });
  check("Ready assets for A never include another business",
    listing.every((row) => row.businessId === businessA.id));

  console.log("\nDB — Pending orphan object cleanup");
  const serviceSrc = readRepo("src/lib/business-storage/service.ts");
  check("Abort and expiry claim PENDING atomically before decrement or delete",
    serviceSrc.includes('where: { id: existing.id, businessId, status: "PENDING" }') &&
      serviceSrc.includes('where: { id: row.id, businessId, status: "PENDING" }') &&
      serviceSrc.includes("updated.count !== 1") &&
      serviceSrc.includes("if (updated.count === 1) won.push(row)") &&
      serviceSrc.includes("bestEffortCleanupOwnedObject") &&
      serviceSrc.includes("Provider resolution and delete are both best-effort after DB commit.") &&
      serviceSrc.includes("One provider delete failure must not block the rest of the expired set."));
  check("Finalize claims PENDING atomically before READY accounting",
    serviceSrc.includes('id: asset.id,\n        businessId,\n        status: "PENDING"') &&
      serviceSrc.includes("claimed.count === 1") &&
      serviceSrc.includes('if (current?.status === "READY") return { kind: "ready" as const, asset: current }') &&
      serviceSrc.includes('throw new StorageError("That upload is no longer pending.")'));

  const abortTracker = trackDeletes(provider);
  const abortDeps = { ...deps, provider: abortTracker.provider };
  const abortBefore = await accountSnapshot(businessA.id);
  const pendingAbort = await authorizeManagedUpload(abortDeps, businessA.id, {
    category: "DOCUMENT",
    purpose: "orphan-abort",
    originalFilename: "abort-orphan.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: jpeg.byteLength,
    visibility: "PRIVATE",
  });
  await abortTracker.provider.putObject({
    bucket: pendingAbort.account.bucketName,
    key: pendingAbort.asset.storageKey,
    body: jpeg,
    contentType: "image/jpeg",
  });
  check("Abort fixture uploaded bytes before abort",
    await abortTracker.provider.objectExists({
      bucket: pendingAbort.account.bucketName,
      key: pendingAbort.asset.storageKey,
    }));
  const aborted = await abortManagedUpload(abortDeps, businessA.id, pendingAbort.asset.id);
  const abortAfter = await accountSnapshot(businessA.id);
  const abortedRow = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: pendingAbort.asset.id },
  });
  check("Abort marks PENDING FAILED and deletes the uploaded object once",
    aborted.status === "FAILED" &&
      abortedRow.status === "FAILED" &&
      abortedRow.deletedAt != null &&
      abortAfter.reserved === abortBefore.reserved &&
      abortAfter.used === abortBefore.used &&
      abortTracker.deletes.length === 1 &&
      abortTracker.deletes[0].bucket === pendingAbort.account.bucketName &&
      abortTracker.deletes[0].key === pendingAbort.asset.storageKey &&
      !(await abortTracker.provider.objectExists({
        bucket: pendingAbort.account.bucketName,
        key: pendingAbort.asset.storageKey,
      })));

  const abortRepeat = await abortManagedUpload(abortDeps, businessA.id, pendingAbort.asset.id);
  const abortAfterRepeat = await accountSnapshot(businessA.id);
  check("Repeated abort is idempotent and does not decrement reservation again",
    abortRepeat.status === "FAILED" &&
      abortAfterRepeat.reserved === abortAfter.reserved &&
      abortAfterRepeat.used === abortAfter.used &&
      abortTracker.deletes.length === 1);

  const failTracker = trackDeletes(provider, { failAll: true });
  const failDeps = { ...deps, provider: failTracker.provider };
  const failBefore = await accountSnapshot(businessA.id);
  const pendingFail = await authorizeManagedUpload(failDeps, businessA.id, {
    category: "DOCUMENT",
    purpose: "orphan-delete-fail",
    originalFilename: "delete-fail.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: jpeg.byteLength,
    visibility: "PRIVATE",
  });
  await failTracker.provider.putObject({
    bucket: pendingFail.account.bucketName,
    key: pendingFail.asset.storageKey,
    body: jpeg,
    contentType: "image/jpeg",
  });
  const failedAbort = await abortManagedUpload(failDeps, businessA.id, pendingFail.asset.id);
  const failAfter = await accountSnapshot(businessA.id);
  const failedRow = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: pendingFail.asset.id },
  });
  check("deleteObject failure still marks FAILED and releases reservation once",
    failedAbort.status === "FAILED" &&
      failedRow.status === "FAILED" &&
      failedRow.deletedAt != null &&
      failAfter.reserved === failBefore.reserved &&
      failAfter.used === failBefore.used &&
      failTracker.deletes.length === 1 &&
      await failTracker.provider.objectExists({
        bucket: pendingFail.account.bucketName,
        key: pendingFail.asset.storageKey,
      }));
  await abortManagedUpload(failDeps, businessA.id, pendingFail.asset.id);
  const failAfterRepeat = await accountSnapshot(businessA.id);
  check("deleteObject failure does not restore PENDING or re-reserve on repeat abort",
    (await prisma.storedAsset.findUniqueOrThrow({ where: { id: pendingFail.asset.id } })).status === "FAILED" &&
      failAfterRepeat.reserved === failAfter.reserved &&
      failAfterRepeat.used === failAfter.used &&
      failTracker.deletes.length === 1);

  const readyBefore = await accountSnapshot(businessA.id);
  const readyDeletesBefore = abortTracker.deletes.length;
  const readyAbort = await abortManagedUpload(abortDeps, businessA.id, privateAsset.id);
  const readyAfter = await accountSnapshot(businessA.id);
  const readyStillThere = await abortTracker.provider.objectExists({
    bucket: privateAuth.account.bucketName,
    key: privateAsset.storageKey,
  });
  check("READY abort is a no-op for deletion and accounting",
    readyAbort.status === "READY" &&
      readyAfter.reserved === readyBefore.reserved &&
      readyAfter.used === readyBefore.used &&
      abortTracker.deletes.length === readyDeletesBefore &&
      readyStillThere);

  await expectThrow("Foreign business cannot abort another business asset", () =>
    abortManagedUpload(abortDeps, businessB.id, pendingAbort.asset.id),
  (error) => error instanceof StorageAccessError);
  const foreignStillFailed = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: pendingAbort.asset.id },
  });
  const foreignAccountA = await accountSnapshot(businessA.id);
  check("Foreign abort fails closed without mutating the owner account",
    foreignStillFailed.status === "FAILED" &&
      foreignAccountA.reserved === abortAfterRepeat.reserved &&
      foreignAccountA.used === abortAfterRepeat.used);

  const expiryTracker = trackDeletes(provider);
  const expiryDeps = { ...deps, provider: expiryTracker.provider };
  const expiryBefore = await accountSnapshot(businessA.id);
  const expiredOne = await authorizeManagedUpload(expiryDeps, businessA.id, {
    category: "DOCUMENT",
    purpose: "expired-one",
    originalFilename: "expired-one.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 40,
    visibility: "PRIVATE",
  });
  const expiredTwo = await authorizeManagedUpload(expiryDeps, businessA.id, {
    category: "DOCUMENT",
    purpose: "expired-two",
    originalFilename: "expired-two.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 50,
    visibility: "PRIVATE",
  });
  await expiryTracker.provider.putObject({
    bucket: expiredOne.account.bucketName,
    key: expiredOne.asset.storageKey,
    body: jpeg,
    contentType: "image/jpeg",
  });
  await expiryTracker.provider.putObject({
    bucket: expiredTwo.account.bucketName,
    key: expiredTwo.asset.storageKey,
    body: jpeg,
    contentType: "image/jpeg",
  });
  expiryTracker.provider.deleteObject = async (input) => {
    expiryTracker.deletes.push({ bucket: input.bucket, key: input.key });
    if (input.key === expiredOne.asset.storageKey) {
      throw new Error("simulated provider deleteObject failure");
    }
    return provider.deleteObject(input);
  };
  const past = new Date(Date.now() - 60_000);
  await prisma.storedAsset.updateMany({
    where: { id: { in: [expiredOne.asset.id, expiredTwo.asset.id] } },
    data: { expiresAt: past },
  });
  const afterExpiryAuthorize = await authorizeManagedUpload(expiryDeps, businessA.id, {
    category: "DOCUMENT",
    purpose: "after-expiry",
    originalFilename: "after-expiry.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 12,
    visibility: "PRIVATE",
  });
  const expiredOneRow = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: expiredOne.asset.id },
  });
  const expiredTwoRow = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: expiredTwo.asset.id },
  });
  const expiryAfter = await accountSnapshot(businessA.id);
  const expiryDeleteKeys = expiryTracker.deletes.map((row) => row.key).sort();
  check("Expiry cleanup marks FAILED, releases reservation once, and deletes independently",
    expiredOneRow.status === "FAILED" &&
      expiredTwoRow.status === "FAILED" &&
      expiredOneRow.deletedAt != null &&
      expiredTwoRow.deletedAt != null &&
      expiryAfter.used === expiryBefore.used &&
      expiryAfter.reserved === expiryBefore.reserved + afterExpiryAuthorize.asset.fileSizeBytes &&
      expiryDeleteKeys.includes(expiredOne.asset.storageKey) &&
      expiryDeleteKeys.includes(expiredTwo.asset.storageKey) &&
      await expiryTracker.provider.objectExists({
        bucket: expiredOne.account.bucketName,
        key: expiredOne.asset.storageKey,
      }) &&
      !(await expiryTracker.provider.objectExists({
        bucket: expiredTwo.account.bucketName,
        key: expiredTwo.asset.storageKey,
      })));
  check("authorize after expiry uses the released reservation for quota",
    afterExpiryAuthorize.asset.status === "PENDING" &&
      afterExpiryAuthorize.asset.fileSizeBytes === 12);
  await abortManagedUpload(expiryDeps, businessA.id, afterExpiryAuthorize.asset.id);

  const oversizedTracker = trackDeletes(provider);
  const oversizedDeps = { ...deps, provider: oversizedTracker.provider };
  const oversizedBefore = await accountSnapshot(businessA.id);
  const oversizedAuth = await authorizeManagedUpload(oversizedDeps, businessA.id, {
    category: "DOCUMENT",
    purpose: "oversized-finalize",
    originalFilename: "oversized.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 4,
    visibility: "PRIVATE",
  });
  await oversizedTracker.provider.putObject({
    bucket: oversizedAuth.account.bucketName,
    key: oversizedAuth.asset.storageKey,
    body: jpeg,
    contentType: "image/jpeg",
  });
  await expectThrow("Oversized finalize still aborts, deletes, and throws StorageQuotaError", () =>
    finalizeManagedUpload(oversizedDeps, businessA.id, oversizedAuth.asset.id),
  (error) => error instanceof StorageQuotaError && error.message.includes("larger than what was authorized"));
  const oversizedRow = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: oversizedAuth.asset.id },
  });
  const oversizedAfter = await accountSnapshot(businessA.id);
  check("Oversized finalize does not double-decrement reservation or used bytes",
    oversizedRow.status === "FAILED" &&
      oversizedAfter.reserved === oversizedBefore.reserved &&
      oversizedAfter.used === oversizedBefore.used &&
      oversizedTracker.deletes.filter((row) => row.key === oversizedAuth.asset.storageKey).length === 1 &&
      !(await oversizedTracker.provider.objectExists({
        bucket: oversizedAuth.account.bucketName,
        key: oversizedAuth.asset.storageKey,
      })));

  const concurrentAbortTracker = trackDeletes(provider);
  const concurrentAbortDeps = { ...deps, provider: concurrentAbortTracker.provider };
  const concurrentAbortBefore = await accountSnapshot(businessA.id);
  const concurrentPending = await authorizeManagedUpload(concurrentAbortDeps, businessA.id, {
    category: "DOCUMENT",
    purpose: "concurrent-abort",
    originalFilename: "concurrent-abort.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: jpeg.byteLength,
    visibility: "PRIVATE",
  });
  await concurrentAbortTracker.provider.putObject({
    bucket: concurrentPending.account.bucketName,
    key: concurrentPending.asset.storageKey,
    body: jpeg,
    contentType: "image/jpeg",
  });
  const [concurrentAbortOne, concurrentAbortTwo] = await Promise.all([
    abortManagedUpload(concurrentAbortDeps, businessA.id, concurrentPending.asset.id),
    abortManagedUpload(concurrentAbortDeps, businessA.id, concurrentPending.asset.id),
  ]);
  const concurrentAbortAfter = await accountSnapshot(businessA.id);
  const concurrentAbortRow = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: concurrentPending.asset.id },
  });
  const concurrentAbortDeletes = concurrentAbortTracker.deletes.filter(
    (row) => row.key === concurrentPending.asset.storageKey,
  );
  check("Simultaneous aborts claim PENDING once and decrement reserved once",
    concurrentAbortOne.status === "FAILED" &&
      concurrentAbortTwo.status === "FAILED" &&
      concurrentAbortRow.status === "FAILED" &&
      concurrentAbortAfter.reserved === concurrentAbortBefore.reserved &&
      concurrentAbortAfter.used === concurrentAbortBefore.used &&
      concurrentAbortAfter.reserved >= 0 &&
      concurrentAbortDeletes.length === 1 &&
      !(await concurrentAbortTracker.provider.objectExists({
        bucket: concurrentPending.account.bucketName,
        key: concurrentPending.asset.storageKey,
      })));

  const concurrentExpiryTracker = trackDeletes(provider);
  const concurrentExpiryDeps = { ...deps, provider: concurrentExpiryTracker.provider };
  const concurrentExpiryBefore = await accountSnapshot(businessA.id);
  const sharedExpired = await authorizeManagedUpload(concurrentExpiryDeps, businessA.id, {
    category: "DOCUMENT",
    purpose: "shared-expired",
    originalFilename: "shared-expired.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 40,
    visibility: "PRIVATE",
  });
  await concurrentExpiryTracker.provider.putObject({
    bucket: sharedExpired.account.bucketName,
    key: sharedExpired.asset.storageKey,
    body: jpeg,
    contentType: "image/jpeg",
  });
  await prisma.storedAsset.update({
    where: { id: sharedExpired.asset.id },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const [expiryAuthOne, expiryAuthTwo] = await Promise.all([
    authorizeManagedUpload(concurrentExpiryDeps, businessA.id, {
      category: "DOCUMENT",
      purpose: "after-shared-expiry-a",
      originalFilename: "after-shared-expiry-a.jpg",
      mimeType: "image/jpeg",
      fileSizeBytes: 15,
      visibility: "PRIVATE",
    }),
    authorizeManagedUpload(concurrentExpiryDeps, businessA.id, {
      category: "DOCUMENT",
      purpose: "after-shared-expiry-b",
      originalFilename: "after-shared-expiry-b.jpg",
      mimeType: "image/jpeg",
      fileSizeBytes: 16,
      visibility: "PRIVATE",
    }),
  ]);
  const sharedExpiredRow = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: sharedExpired.asset.id },
  });
  const concurrentExpiryAfter = await accountSnapshot(businessA.id);
  const sharedExpiredDeletes = concurrentExpiryTracker.deletes.filter(
    (row) => row.key === sharedExpired.asset.storageKey,
  );
  check("Simultaneous expiry cleanup releases the expired reservation once",
    sharedExpiredRow.status === "FAILED" &&
      sharedExpiredRow.deletedAt != null &&
      expiryAuthOne.asset.status === "PENDING" &&
      expiryAuthTwo.asset.status === "PENDING" &&
      expiryAuthOne.asset.fileSizeBytes === 15 &&
      expiryAuthTwo.asset.fileSizeBytes === 16 &&
      concurrentExpiryAfter.used === concurrentExpiryBefore.used &&
      concurrentExpiryAfter.reserved === concurrentExpiryBefore.reserved + 15 + 16 &&
      concurrentExpiryAfter.reserved >= 0 &&
      sharedExpiredDeletes.length === 1 &&
      !(await concurrentExpiryTracker.provider.objectExists({
        bucket: sharedExpired.account.bucketName,
        key: sharedExpired.asset.storageKey,
      })));
  await Promise.all([
    abortManagedUpload(concurrentExpiryDeps, businessA.id, expiryAuthOne.asset.id),
    abortManagedUpload(concurrentExpiryDeps, businessA.id, expiryAuthTwo.asset.id),
  ]);

  const resolveBefore = await accountSnapshot(businessA.id);
  const resolvePending = await authorizeManagedUpload(deps, businessA.id, {
    category: "DOCUMENT",
    purpose: "provider-resolve-fail",
    originalFilename: "provider-resolve-fail.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: jpeg.byteLength,
    visibility: "PRIVATE",
  });
  const r2EnvKeys = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"];
  const savedR2Env = Object.fromEntries(r2EnvKeys.map((key) => [key, process.env[key]]));
  for (const key of r2EnvKeys) delete process.env[key];
  let resolveAbortError = null;
  let resolveAbortResult = null;
  try {
    resolveAbortResult = await abortManagedUpload(
      { db: prisma, bucketName: deps.bucketName, defaultLimitBytes: deps.defaultLimitBytes },
      businessA.id,
      resolvePending.asset.id,
    );
  } catch (error) {
    resolveAbortError = error;
  } finally {
    for (const key of r2EnvKeys) {
      if (savedR2Env[key] === undefined) delete process.env[key];
      else process.env[key] = savedR2Env[key];
    }
  }
  const resolveAfter = await accountSnapshot(businessA.id);
  const resolveRow = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: resolvePending.asset.id },
  });
  check("Provider resolution failure after abort keeps FAILED and released reservation",
    resolveAbortError == null &&
      resolveAbortResult?.status === "FAILED" &&
      resolveRow.status === "FAILED" &&
      resolveRow.deletedAt != null &&
      resolveAfter.reserved === resolveBefore.reserved &&
      resolveAfter.used === resolveBefore.used &&
      resolveAfter.reserved >= 0);

  const readyFinalizeBefore = await accountSnapshot(businessA.id);
  const readyFinalize = await finalizeManagedUpload(deps, businessA.id, privateAsset.id);
  const readyFinalizeAfter = await accountSnapshot(businessA.id);
  check("READY finalize is idempotent and does not change accounting",
    readyFinalize.status === "READY" &&
      readyFinalize.id === privateAsset.id &&
      readyFinalizeAfter.reserved === readyFinalizeBefore.reserved &&
      readyFinalizeAfter.used === readyFinalizeBefore.used);

  const vsAbortTracker = trackDeletes(provider);
  const vsAbortDeps = { ...deps, provider: vsAbortTracker.provider };
  const vsAbortBefore = await accountSnapshot(businessA.id);
  const vsAbortPending = await authorizeManagedUpload(vsAbortDeps, businessA.id, {
    category: "DOCUMENT",
    purpose: "finalize-vs-abort",
    originalFilename: "finalize-vs-abort.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: jpeg.byteLength,
    visibility: "PRIVATE",
  });
  await vsAbortTracker.provider.putObject({
    bucket: vsAbortPending.account.bucketName,
    key: vsAbortPending.asset.storageKey,
    body: jpeg,
    contentType: "image/jpeg",
  });
  const [vsAbortFinalize, vsAbortAbort] = await Promise.allSettled([
    finalizeManagedUpload(vsAbortDeps, businessA.id, vsAbortPending.asset.id),
    abortManagedUpload(vsAbortDeps, businessA.id, vsAbortPending.asset.id),
  ]);
  const vsAbortRow = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: vsAbortPending.asset.id },
  });
  const vsAbortAfter = await accountSnapshot(businessA.id);
  const vsAbortDeletes = vsAbortTracker.deletes.filter(
    (row) => row.key === vsAbortPending.asset.storageKey,
  );
  const vsAbortExists = await vsAbortTracker.provider.objectExists({
    bucket: vsAbortPending.account.bucketName,
    key: vsAbortPending.asset.storageKey,
  });
  const finalizeWonAbortRace =
    vsAbortRow.status === "READY" &&
    vsAbortFinalize.status === "fulfilled" &&
    vsAbortFinalize.value.status === "READY" &&
    vsAbortAbort.status === "fulfilled" &&
    vsAbortAbort.value.status === "READY" &&
    vsAbortAfter.reserved === vsAbortBefore.reserved &&
    vsAbortAfter.used === vsAbortBefore.used + jpeg.byteLength &&
    vsAbortDeletes.length === 0 &&
    vsAbortExists;
  const abortWonFinalizeRace =
    vsAbortRow.status === "FAILED" &&
    vsAbortFinalize.status === "rejected" &&
    vsAbortFinalize.reason instanceof StorageError &&
    vsAbortAbort.status === "fulfilled" &&
    vsAbortAbort.value.status === "FAILED" &&
    vsAbortAfter.reserved === vsAbortBefore.reserved &&
    vsAbortAfter.used === vsAbortBefore.used &&
    vsAbortDeletes.length === 1 &&
    !vsAbortExists;
  check("Finalize vs abort has one PENDING terminal owner and one accounting path",
    (finalizeWonAbortRace || abortWonFinalizeRace) &&
      vsAbortAfter.reserved >= 0 &&
      vsAbortRow.status !== "PENDING" &&
      !(vsAbortRow.status === "READY" && !vsAbortExists));

  const vsFinalizeTracker = trackDeletes(provider);
  const vsFinalizeDeps = { ...deps, provider: vsFinalizeTracker.provider };
  const vsFinalizeBefore = await accountSnapshot(businessA.id);
  const vsFinalizePending = await authorizeManagedUpload(vsFinalizeDeps, businessA.id, {
    category: "DOCUMENT",
    purpose: "finalize-vs-finalize",
    originalFilename: "finalize-vs-finalize.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: jpeg.byteLength,
    visibility: "PRIVATE",
  });
  await vsFinalizeTracker.provider.putObject({
    bucket: vsFinalizePending.account.bucketName,
    key: vsFinalizePending.asset.storageKey,
    body: jpeg,
    contentType: "image/jpeg",
  });
  const [finalizeOne, finalizeTwo] = await Promise.all([
    finalizeManagedUpload(vsFinalizeDeps, businessA.id, vsFinalizePending.asset.id),
    finalizeManagedUpload(vsFinalizeDeps, businessA.id, vsFinalizePending.asset.id),
  ]);
  const vsFinalizeRow = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: vsFinalizePending.asset.id },
  });
  const vsFinalizeAfter = await accountSnapshot(businessA.id);
  const vsFinalizeDeletes = vsFinalizeTracker.deletes.filter(
    (row) => row.key === vsFinalizePending.asset.storageKey,
  );
  check("Simultaneous finalize claims PENDING once and accounts once",
    finalizeOne.status === "READY" &&
      finalizeTwo.status === "READY" &&
      vsFinalizeRow.status === "READY" &&
      vsFinalizeAfter.reserved === vsFinalizeBefore.reserved &&
      vsFinalizeAfter.used === vsFinalizeBefore.used + jpeg.byteLength &&
      vsFinalizeAfter.reserved >= 0 &&
      vsFinalizeDeletes.length === 0 &&
      await vsFinalizeTracker.provider.objectExists({
        bucket: vsFinalizePending.account.bucketName,
        key: vsFinalizePending.asset.storageKey,
      }));

  const vsExpiryTracker = trackDeletes(provider);
  const vsExpiryDeps = { ...deps, provider: vsExpiryTracker.provider };
  const vsExpiryBefore = await accountSnapshot(businessA.id);
  const vsExpiryPending = await authorizeManagedUpload(vsExpiryDeps, businessA.id, {
    category: "DOCUMENT",
    purpose: "finalize-vs-expiry",
    originalFilename: "finalize-vs-expiry.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 40,
    visibility: "PRIVATE",
  });
  await vsExpiryTracker.provider.putObject({
    bucket: vsExpiryPending.account.bucketName,
    key: vsExpiryPending.asset.storageKey,
    body: jpeg,
    contentType: "image/jpeg",
  });
  await prisma.storedAsset.update({
    where: { id: vsExpiryPending.asset.id },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const [vsExpiryFinalize, vsExpiryAuthorize] = await Promise.allSettled([
    finalizeManagedUpload(vsExpiryDeps, businessA.id, vsExpiryPending.asset.id),
    authorizeManagedUpload(vsExpiryDeps, businessA.id, {
      category: "DOCUMENT",
      purpose: "after-finalize-expiry",
      originalFilename: "after-finalize-expiry.jpg",
      mimeType: "image/jpeg",
      fileSizeBytes: 12,
      visibility: "PRIVATE",
    }),
  ]);
  const vsExpiryRow = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: vsExpiryPending.asset.id },
  });
  const vsExpiryAfter = await accountSnapshot(businessA.id);
  const vsExpiryDeletes = vsExpiryTracker.deletes.filter(
    (row) => row.key === vsExpiryPending.asset.storageKey,
  );
  const vsExpiryExists = await vsExpiryTracker.provider.objectExists({
    bucket: vsExpiryPending.account.bucketName,
    key: vsExpiryPending.asset.storageKey,
  });
  const authorizeAfterExpiry =
    vsExpiryAuthorize.status === "fulfilled" ? vsExpiryAuthorize.value : null;
  const finalizeWonExpiryRace =
    vsExpiryRow.status === "READY" &&
    vsExpiryFinalize.status === "fulfilled" &&
    vsExpiryFinalize.value.status === "READY" &&
    authorizeAfterExpiry?.asset.status === "PENDING" &&
    vsExpiryAfter.used === vsExpiryBefore.used + jpeg.byteLength &&
    vsExpiryAfter.reserved === vsExpiryBefore.reserved + 12 &&
    vsExpiryDeletes.length === 0 &&
    vsExpiryExists;
  const expiryWonFinalizeRace =
    vsExpiryRow.status === "FAILED" &&
    vsExpiryFinalize.status === "rejected" &&
    vsExpiryFinalize.reason instanceof StorageError &&
    authorizeAfterExpiry?.asset.status === "PENDING" &&
    vsExpiryAfter.used === vsExpiryBefore.used &&
    vsExpiryAfter.reserved === vsExpiryBefore.reserved + 12 &&
    vsExpiryDeletes.length === 1 &&
    !vsExpiryExists;
  check("Finalize vs expiry has one PENDING terminal owner and one accounting path",
    (finalizeWonExpiryRace || expiryWonFinalizeRace) &&
      vsExpiryAfter.reserved >= 0 &&
      vsExpiryRow.status !== "PENDING" &&
      !(vsExpiryRow.status === "READY" && !vsExpiryExists));
  if (authorizeAfterExpiry?.asset.id) {
    await abortManagedUpload(vsExpiryDeps, businessA.id, authorizeAfterExpiry.asset.id);
  }

  console.log("\nDB — Delete versus discard READY used-bytes claim");
  const raceServiceSrc = readRepo("src/lib/business-storage/service.ts");
  const raceDeleteSrc = raceServiceSrc.slice(
    raceServiceSrc.indexOf("export async function deleteStoredAsset"),
    raceServiceSrc.indexOf("export async function assertOwnedStoredAsset"),
  );
  const raceDiscardSrc = raceServiceSrc.slice(
    raceServiceSrc.indexOf("export async function discardReadyManagedUpload"),
    raceServiceSrc.indexOf("export async function abortBusinessUpload"),
  );
  const raceClaimSrc = raceServiceSrc.slice(
    raceServiceSrc.indexOf("async function claimReadyUsedBytesOnce"),
    raceServiceSrc.indexOf("export async function discardReadyManagedUpload"),
  );
  check(
    "Delete and discard share one READY used-bytes claim under account-then-asset locks",
    raceClaimSrc.includes("lockAccountThenPendingAsset") &&
      raceClaimSrc.includes('status !== "READY"') &&
      raceClaimSrc.includes('status: "READY"') &&
      raceClaimSrc.includes("storageUsedBytes: { decrement: current.fileSizeBytes }") &&
      raceDeleteSrc.includes("claimReadyUsedBytesOnce") &&
      raceDeleteSrc.includes("afterDeleteStatusRead") &&
      raceDeleteSrc.indexOf("afterDeleteStatusRead") < raceDeleteSrc.indexOf("$transaction") &&
      raceDeleteSrc.indexOf("provider.deleteObject") < raceDeleteSrc.indexOf("$transaction") &&
      !raceDeleteSrc.includes('if (asset.status === "READY" && asset.fileSizeBytes > 0)') &&
      !/\$transaction\([\s\S]*deleteObject/.test(raceDeleteSrc) &&
      raceDiscardSrc.includes("claimReadyUsedBytesOnce") &&
      raceDiscardSrc.includes("afterDiscardStatusRead") &&
      raceDiscardSrc.indexOf("$transaction") <
        raceDiscardSrc.indexOf("bestEffortCleanupOwnedObject"),
  );

  async function seedReadyDiscardTarget(label) {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
    const user = await prisma.user.create({
      data: {
        name: `Race ${label}`,
        email: `race-${label}-${suffix}@example.com`,
        passwordHash: "x",
      },
    });
    const business = await prisma.business.create({
      data: {
        name: `Race ${label} ${suffix}`,
        slug: `race-${label}-${suffix}`,
        tradeCode: "HANDYMAN",
      },
    });
    const membership = await prisma.membership.create({
      data: { userId: user.id, businessId: business.id, role: "OWNER" },
    });
    const customer = await prisma.customer.create({
      data: { businessId: business.id, name: `Race ${label}` },
    });
    const property = await prisma.property.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        addressLine1: "1 Race Street",
        city: "Reno",
        region: "NV",
        postalCode: "89501",
      },
    });
    const job = await prisma.job.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        propertyId: property.id,
        projectToken: randomUUID(),
        status: "IN_PROGRESS",
      },
    });
    const access = makeAccess(business.id, "OWNER", membership.id);
    const raceProvider = new MemoryStorageProvider();
    const raceDeps = {
      db: prisma,
      provider: raceProvider,
      bucketName: "tbbt-managed-test",
      defaultLimitBytes: 1_000_000,
    };
    const authorized = await authorizeManagedUpload(raceDeps, business.id, {
      category: "JOB_PHOTO",
      purpose: "field-job-photo",
      originalFilename: `${label}.jpg`,
      mimeType: "image/jpeg",
      fileSizeBytes: jpeg.byteLength,
      visibility: "PRIVATE",
      jobId: job.id,
      customerId: customer.id,
      propertyId: property.id,
    });
    await raceProvider.putObject({
      bucket: authorized.account.bucketName,
      key: authorized.asset.storageKey,
      body: jpeg,
      contentType: "image/jpeg",
    });
    const ready = await finalizeManagedUpload(raceDeps, business.id, authorized.asset.id);
    return {
      business,
      access,
      job,
      ready,
      provider: raceProvider,
      fileSize: Number(ready.fileSizeBytes),
    };
  }

  async function runDeleteDiscardCommitOrder(firstWriter) {
    const seeded = await seedReadyDiscardTarget(firstWriter);
    const before = await accountSnapshot(seeded.business.id);
    const deleteClient = new PrismaClient({ datasourceUrl: testUrl });
    const discardClient = new PrismaClient({ datasourceUrl: testUrl });
    const barrier = createCommitBarrier();
    const deleteDeps = {
      db: deleteClient,
      provider: seeded.provider,
      bucketName: "tbbt-managed-test",
      defaultLimitBytes: 1_000_000,
    };
    const discardDeps = {
      db: discardClient,
      provider: seeded.provider,
      bucketName: "tbbt-managed-test",
      defaultLimitBytes: 1_000_000,
    };
    const match = discardMatchFor(seeded.ready);
    try {
      if (firstWriter === "discard") {
        managedStorageWriteTestHooks.afterDeleteStatusRead = barrier.wait;
        const deleteHeld = deleteStoredAsset(deleteDeps, seeded.access, seeded.ready.id);
        await withTimeout(barrier.arrived, 4000, "delete read READY before discard commit");
        const discarded = await discardReadyManagedUpload(
          discardDeps,
          seeded.business.id,
          seeded.ready.id,
          match,
        );
        barrier.release();
        const deleted = await deleteHeld;
        const repeat = await deleteStoredAsset(deleteDeps, seeded.access, seeded.ready.id);
        return { seeded, before, discarded, deleted, repeat };
      }
      managedStorageWriteTestHooks.afterDiscardStatusRead = barrier.wait;
      const discardHeld = discardReadyManagedUpload(
        discardDeps,
        seeded.business.id,
        seeded.ready.id,
        match,
      );
      await withTimeout(barrier.arrived, 4000, "discard read READY before delete commit");
      const deleted = await deleteStoredAsset(deleteDeps, seeded.access, seeded.ready.id);
      barrier.release();
      const discarded = await discardHeld;
      const repeat = await deleteStoredAsset(deleteDeps, seeded.access, seeded.ready.id);
      return { seeded, before, discarded, deleted, repeat };
    } finally {
      delete managedStorageWriteTestHooks.afterDeleteStatusRead;
      delete managedStorageWriteTestHooks.afterDiscardStatusRead;
      await deleteClient.$disconnect();
      await discardClient.$disconnect();
    }
  }

  for (const firstWriter of ["discard", "delete"]) {
    const raced = await runDeleteDiscardCommitOrder(firstWriter);
    const after = await accountSnapshot(raced.seeded.business.id);
    const row = await prisma.storedAsset.findUniqueOrThrow({
      where: { id: raced.seeded.ready.id },
    });
    check(
      `${firstWriter}-first two-connection race claims used bytes once and repeat delete is a no-op`,
      after.used === raced.before.used - raced.seeded.fileSize &&
        after.used >= 0 &&
        after.reserved === 0 &&
        row.status === "DELETED" &&
        raced.deleted.status === "DELETED" &&
        raced.repeat.status === "DELETED" &&
        raced.repeat.id === raced.seeded.ready.id,
    );
  }
} finally {
  await prisma.$disconnect();
  spawnSync("psql", [baseUrl, "-c", `DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE);`], {
    stdio: "ignore",
  });
}

if (failures > 0) {
  console.error(`\n${failures} business storage check(s) failed.`);
  process.exit(1);
}
console.log("\nBusiness storage checks passed.");

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
  ensureBusinessStorageAccount,
  finalizeBusinessUpload,
  finalizeManagedUpload,
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
  check("Abort and expiry own object-delete after reservation release",
    /await deps\.db\.\$transaction\(async \(tx\) => \{[\s\S]*storageReservedBytes: \{ decrement: asset\.fileSizeBytes \}[\s\S]*bestEffortDeleteOwnedObject/.test(serviceSrc) &&
      /storageReservedBytes: \{ decrement: reserved \}[\s\S]*bestEffortDeleteOwnedObject/.test(serviceSrc) &&
      serviceSrc.includes("One provider delete failure must not block the rest of the expired set."));

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
      oversizedTracker.deletes.some((row) => row.key === oversizedAuth.asset.storageKey) &&
      !(await oversizedTracker.provider.objectExists({
        bucket: oversizedAuth.account.bucketName,
        key: oversizedAuth.asset.storageKey,
      })));
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

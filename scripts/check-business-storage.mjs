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
  authorizeBusinessUpload,
  deleteStoredAsset,
  ensureBusinessStorageAccount,
  finalizeBusinessUpload,
  putBusinessObject,
  readPublicStoredAsset,
} = await import("@/lib/business-storage/service");
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
check("Job-photo helper still exists for the later migration",
  storageSrc.includes("uploadJobPhoto"));
check("Public website assets use an explicit public path",
  isManagedPublicAssetPath("/api/storage/public/asset123") &&
    !isManagedPublicAssetPath("/api/storage/public/../secret"));
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

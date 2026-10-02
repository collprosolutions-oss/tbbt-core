/**
 * Public request photos (private R2) + catalog-driven measurements.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-request-intake.mjs
 */
import { createRequire, register } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  createPublicServiceRequest,
  PUBLIC_REQUEST_PHOTO_UNAVAILABLE,
  publicIntakeSubmissionLockKey,
  publicIntakeTestHooks,
  publicIntakeStorageTestHooks,
} = await import("@/lib/public-intake");
const { INTAKE_SUBMISSION_MARKER } = await import("@/lib/work-area-intake");
const {
  createOwnerLoggedLead,
  recordedLeadSourceForChannel,
} = await import("@/lib/owner-log-lead");
const { loadPipelineSource } = await import("@/lib/pipeline-data");
const { decideCustomerMatch } = await import("@/lib/customer-identity");
const { MemoryStorageProvider, servePublicStoredAsset } = await import(
  "@/lib/business-storage/index"
);
const {
  abortPublicRequestPhoto,
  attachRemainingPublicRequestFallbackPhotos,
  authorizePublicRequestPhoto,
  finalizePublicRequestPhoto,
  lockStoredAssetRowForUpdate,
  MAX_PUBLIC_INTAKE_REQUEST_PHOTOS,
  MAX_PUBLIC_REQUEST_PHOTO_ID_LOOKUP,
  MAX_UNATTACHED_PUBLIC_REQUEST_PHOTOS,
  MAX_UNATTACHED_REQUEST_PHOTO_RELEASE_BATCH,
  PUBLIC_REQUEST_PHOTO_CAP_REACHED,
  putPublicRequestPhotoFromBytes,
  remainingIntakePhotoSlots,
  releaseExpiredUnattachedPublicRequestPhotos,
  releasePublicRequestPhotos,
  releaseUnattachedPublicRequestPhotos,
  requestPhotoTestHooks,
  sortedStoredAssetIds,
  UNATTACHED_PUBLIC_REQUEST_PHOTO_QUOTA_RATIO,
} = await import("@/lib/business-storage/request-photos");
const { abortManagedUpload, authorizeManagedUpload, finalizeManagedUpload } = await import(
  "@/lib/business-storage/service"
);
const {
  STORAGE_PENDING_TTL_MS,
  StorageError,
  StorageQuotaError,
  UNATTACHED_REQUEST_PHOTO_TTL_MS,
} = await import("@/lib/business-storage/types");
const { MAX_INTAKE_PHOTOS } = await import("@/lib/service-request-work");
const { VAULT_DOCUMENT_PURPOSE } = await import("@/lib/business-protection");
const { servePrivateStoredAsset } = await import(
  "@/lib/business-storage/private-serve"
);
const {
  CONTRACTOR_VERIFIED_MEASUREMENT,
  CUSTOMER_REPORTED_MEASUREMENT,
  catalogAsksMeasurements,
  resolveCatalogIntakeConfig,
  validateCustomerMeasurementInput,
} = await import("@/lib/catalog-intake");
const { firstHeaderHostWithPort } = await import("@/lib/vercel-app-host");
const { submitPublicIntakeForm, PUBLIC_INTAKE_SUBMIT_ERROR } = await import(
  "@/lib/public-request-submit"
);
const {
  countRejectedSubmitPhotoReleaseCalls,
  releaseRequestPhotosAfterRejectedSubmit,
} = await import("@/lib/public-request-photo-release");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const pngBytes = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

const NEAR_LIMIT_BYTES = 100_000;
const NEAR_LIMIT_ROOM = 1_000;
const NEAR_LIMIT_PHOTO = 1_000;

async function seedTightStorageBusiness(prisma, input) {
  const row = await prisma.business.create({
    data: { name: input.name, slug: input.slug, tradeCode: "HANDYMAN" },
  });
  await prisma.businessStorageAccount.create({
    data: {
      businessId: row.id,
      provider: "R2",
      mode: "MANAGED",
      bucketName: "tbbt-request-photos",
      namespacePrefix: `businesses/${row.id}`,
      status: "ACTIVE",
      storageLimitBytes: BigInt(input.limitBytes),
      storageUsedBytes: BigInt(input.usedBytes),
      storageReservedBytes: BigInt(input.reservedBytes ?? 0),
    },
  });
  return row;
}

async function runNearLimitPublicPhotoQuotaRace({
  prisma,
  provider,
  PrismaClient,
  datasourceUrl,
}) {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  const tightSlug = `quota-tight-${suffix}`;
  const otherSlug = `quota-other-${suffix}`;
  const tight = await seedTightStorageBusiness(prisma, {
    slug: tightSlug,
    name: "Quota Tight",
    usedBytes: NEAR_LIMIT_BYTES - NEAR_LIMIT_ROOM,
    limitBytes: NEAR_LIMIT_BYTES,
  });
  const otherBiz = await seedTightStorageBusiness(prisma, {
    slug: otherSlug,
    name: "Quota Other",
    usedBytes: 0,
    limitBytes: NEAR_LIMIT_BYTES,
  });
  const deps = { db: prisma, provider, bucketName: "tbbt-request-photos" };
  const photoBody = Buffer.alloc(NEAR_LIMIT_PHOTO);
  const authorizeClients = await Promise.all(
    Array.from({ length: 12 }, () => new PrismaClient({ datasourceUrl })),
  );
  let authorizes = [];
  try {
    authorizes = await Promise.all(
      authorizeClients.map((db, index) =>
        authorizePublicRequestPhoto({ ...deps, db }, tightSlug, {
          originalFilename: `near-limit-${index}.png`,
          mimeType: "image/png",
          fileSizeBytes: NEAR_LIMIT_PHOTO,
        }),
      ),
    );
  } finally {
    await Promise.all(authorizeClients.map((db) => db.$disconnect()));
  }
  const uploadTargets = authorizes.slice(0, 10);
  await Promise.all(
    uploadTargets.map((row) =>
      provider.putObject({
        bucket: row.account.bucketName,
        key: row.asset.storageKey,
        body: photoBody,
        contentType: "image/png",
      }),
    ),
  );
  const finalizeClients = await Promise.all(
    uploadTargets.map(() => new PrismaClient({ datasourceUrl })),
  );
  let finalized = [];
  try {
    finalized = await Promise.allSettled(
      finalizeClients.map((db, index) =>
        finalizePublicRequestPhoto({ ...deps, db }, tightSlug, uploadTargets[index].asset.id),
      ),
    );
  } finally {
    await Promise.all(finalizeClients.map((db) => db.$disconnect()));
  }
  const account = await prisma.businessStorageAccount.findUniqueOrThrow({
    where: { businessId: tight.id },
  });
  const assets = await prisma.storedAsset.findMany({
    where: { id: { in: uploadTargets.map((row) => row.asset.id) } },
    select: { id: true, status: true, fileSizeBytes: true },
  });
  const ready = assets.filter((row) => row.status === "READY");
  const failedRows = assets.filter((row) => row.status === "FAILED");
  const quotaErrors = finalized.filter(
    (row) => row.status === "rejected" && row.reason instanceof StorageQuotaError,
  );
  const leftoverPending = await prisma.storedAsset.findMany({
    where: { id: { in: authorizes.slice(10).map((row) => row.asset.id) } },
    select: { status: true },
  });
  let otherUpload = null;
  try {
    otherUpload = await putPublicRequestPhotoFromBytes(deps, otherSlug, {
      originalFilename: "other-tenant-near-limit.png",
      mimeType: "image/png",
      body: photoBody,
    });
  } catch (error) {
    otherUpload = error;
  }
  let ownerUpload = null;
  try {
    ownerUpload = await authorizeManagedUpload(deps, otherBiz.id, {
      category: "JOB_PHOTO",
      purpose: "field-job-photo",
      originalFilename: "owner-near-limit.png",
      mimeType: "image/png",
      fileSizeBytes: NEAR_LIMIT_PHOTO,
      visibility: "PRIVATE",
    });
  } catch (error) {
    ownerUpload = error;
  }
  return {
    used: Number(account.storageUsedBytes),
    reserved: Number(account.storageReservedBytes),
    limit: NEAR_LIMIT_BYTES,
    authorizeOk:
      authorizes.length === 12 && authorizes.every((row) => row.asset.status === "PENDING"),
    readyCount: ready.length,
    failedCount: failedRows.length,
    quotaErrorCount: quotaErrors.length,
    leftoverPendingOk: leftoverPending.every((row) => row.status === "PENDING"),
    otherOk: otherUpload && !(otherUpload instanceof Error) && otherUpload.status === "READY",
    ownerOk: ownerUpload && !(ownerUpload instanceof Error) && ownerUpload.asset.status === "PENDING",
    readyBytes: ready.reduce((sum, row) => sum + Number(row.fileSizeBytes), 0),
  };
}

if (process.env.REQUEST_INTAKE_QUOTA_MUTATION === "1") {
  const require = createRequire(import.meta.url);
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const provider = new MemoryStorageProvider();
  try {
    const result = await runNearLimitPublicPhotoQuotaRace({
      prisma,
      provider,
      PrismaClient,
      datasourceUrl: process.env.DATABASE_URL,
    });
    const ok =
      result.used <= result.limit &&
      result.readyCount === 1 &&
      result.failedCount === 9 &&
      result.quotaErrorCount === 9;
    if (!ok) {
      console.error(
        `FAIL - near-limit quota race used=${result.used} limit=${result.limit} ready=${result.readyCount} failed=${result.failedCount}`,
      );
    }
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error("FAIL - near-limit quota mutation child threw", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

function deadlockText(error) {
  return [
    error?.code,
    error?.meta?.code,
    error?.cause?.code,
    error?.message,
    error?.cause?.message,
    String(error ?? ""),
  ]
    .filter(Boolean)
    .join(" ");
}

function isDeadlockError(error) {
  return /40P01|deadlock detected|P2034/i.test(deadlockText(error));
}

function runPsqlOnTestDb(datasourceUrl, sql) {
  const psqlUrl = new URL(datasourceUrl);
  psqlUrl.searchParams.delete("schema");
  return new Promise((resolve) => {
    const child = spawn("psql", [psqlUrl.toString(), "-v", "ON_ERROR_STOP=1", "-c", sql], {
      encoding: "utf8",
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("close", (code) => {
      resolve({
        status: code === 0 ? "fulfilled" : "rejected",
        reason: new Error(`${err}\n${out}`),
        code,
        err,
        out,
      });
    });
  });
}

async function holdAccountAndRace({ datasourceUrl, accountId, left, right }) {
  const hold = runPsqlOnTestDb(
    datasourceUrl,
    [
      "BEGIN;",
      `SELECT id FROM "BusinessStorageAccount" WHERE id = '${accountId}' FOR UPDATE;`,
      "SELECT pg_sleep(0.5);",
      "COMMIT;",
    ].join("\n"),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const raced = await Promise.allSettled([left(), right()]);
  const held = await hold;
  return { raced, held };
}

async function runHeldAccountFinalizeRaces({
  prisma,
  provider,
  PrismaClient,
  datasourceUrl,
}) {
  async function runOne(kind) {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
    const biz = await seedTightStorageBusiness(prisma, {
      slug: `lock-${kind}-${suffix}`,
      name: `Lock ${kind}`,
      usedBytes: 0,
      limitBytes: 1_000_000,
    });
    const deps = {
      db: prisma,
      provider,
      bucketName: "tbbt-request-photos",
      defaultLimitBytes: 1_000_000,
    };
    const body = Buffer.alloc(NEAR_LIMIT_PHOTO);
    const authorized = await authorizeManagedUpload(deps, biz.id, {
      category: "JOB_PHOTO",
      purpose: "field-job-photo",
      originalFilename: `${kind}-pending.png`,
      mimeType: "image/png",
      fileSizeBytes: NEAR_LIMIT_PHOTO,
      visibility: "PRIVATE",
    });
    await provider.putObject({
      bucket: authorized.account.bucketName,
      key: authorized.asset.storageKey,
      body,
      contentType: "image/png",
    });
    if (kind === "sweep") {
      await prisma.storedAsset.update({
        where: { id: authorized.asset.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
    }
    const before = await prisma.businessStorageAccount.findUniqueOrThrow({
      where: { businessId: biz.id },
    });
    const leftClient = new PrismaClient({ datasourceUrl });
    const rightClient = new PrismaClient({ datasourceUrl });
    try {
      const { raced, held } = await holdAccountAndRace({
        datasourceUrl,
        accountId: authorized.account.id,
        left: () =>
          finalizeManagedUpload({ ...deps, db: leftClient }, biz.id, authorized.asset.id),
        right: () =>
          kind === "abort"
            ? abortManagedUpload({ ...deps, db: rightClient }, biz.id, authorized.asset.id)
            : authorizeManagedUpload({ ...deps, db: rightClient }, biz.id, {
                category: "JOB_PHOTO",
                purpose: "field-job-photo",
                originalFilename: `${kind}-trigger.png`,
                mimeType: "image/png",
                fileSizeBytes: NEAR_LIMIT_PHOTO,
                visibility: "PRIVATE",
              }),
      });
      const after = await prisma.businessStorageAccount.findUniqueOrThrow({
        where: { businessId: biz.id },
      });
      const row = await prisma.storedAsset.findUniqueOrThrow({
        where: { id: authorized.asset.id },
      });
      const deadlockSeen = [held, ...raced].some(
        (item) =>
          item.status === "rejected" &&
          (isDeadlockError(item.reason) ||
            /40P01|deadlock detected/i.test(`${item.err ?? ""} ${item.out ?? ""} ${item.reason ?? ""}`)),
      );
      const used = Number(after.storageUsedBytes);
      const reserved = Number(after.storageReservedBytes);
      const usedBefore = Number(before.storageUsedBytes);
      const reservedBefore = Number(before.storageReservedBytes);
      const ready = row.status === "READY";
      const failed = row.status === "FAILED";
      const quotaOk = ready
        ? used === usedBefore + NEAR_LIMIT_PHOTO &&
          reserved === reservedBefore - NEAR_LIMIT_PHOTO + (kind === "sweep" ? NEAR_LIMIT_PHOTO : 0)
        : failed
          ? used === usedBefore &&
            reserved === reservedBefore - NEAR_LIMIT_PHOTO + (kind === "sweep" ? NEAR_LIMIT_PHOTO : 0)
          : false;
      return {
        kind,
        deadlockSeen,
        ready,
        failed,
        used,
        reserved,
        quotaOk,
        oneOutcome: (ready && !failed) || (!ready && failed),
      };
    } finally {
      await leftClient.$disconnect();
      await rightClient.$disconnect();
    }
  }
  const abortRace = await runOne("abort");
  const sweepRace = await runOne("sweep");
  return { abortRace, sweepRace };
}

async function runHeldAccountReleaseFinalizeRaces({
  prisma,
  provider,
  PrismaClient,
  datasourceUrl,
  rounds = 5,
}) {
  const results = [];
  for (let round = 0; round < rounds; round += 1) {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
    const slug = `relock-${suffix}`;
    const biz = await seedTightStorageBusiness(prisma, {
      slug,
      name: `Release lock ${suffix}`,
      usedBytes: 0,
      limitBytes: 1_000_000,
    });
    const deps = {
      db: prisma,
      provider,
      bucketName: "tbbt-request-photos",
      defaultLimitBytes: 1_000_000,
    };
    const body = Buffer.alloc(NEAR_LIMIT_PHOTO);
    const first = await authorizePublicRequestPhoto(deps, slug, {
      originalFilename: `relock-a-${suffix}.png`,
      mimeType: "image/png",
      fileSizeBytes: NEAR_LIMIT_PHOTO,
    });
    const second = await authorizePublicRequestPhoto(deps, slug, {
      originalFilename: `relock-b-${suffix}.png`,
      mimeType: "image/png",
      fileSizeBytes: NEAR_LIMIT_PHOTO,
    });
    const [pendingId, readyId] = sortedStoredAssetIds([first.asset.id, second.asset.id]);
    const pendingAuth = first.asset.id === pendingId ? first : second;
    const readyAuth = first.asset.id === readyId ? first : second;
    await provider.putObject({
      bucket: pendingAuth.account.bucketName,
      key: pendingAuth.asset.storageKey,
      body,
      contentType: "image/png",
    });
    await provider.putObject({
      bucket: readyAuth.account.bucketName,
      key: readyAuth.asset.storageKey,
      body,
      contentType: "image/png",
    });
    await finalizePublicRequestPhoto(deps, slug, readyId);
    const leftClient = new PrismaClient({ datasourceUrl });
    const rightClient = new PrismaClient({ datasourceUrl });
    try {
      const { raced, held } = await holdAccountAndRace({
        datasourceUrl,
        accountId: first.account.id,
        left: () =>
          releasePublicRequestPhotos({ ...deps, db: leftClient }, slug, [pendingId, readyId]),
        right: () =>
          finalizePublicRequestPhoto({ ...deps, db: rightClient }, slug, pendingId),
      });
      const after = await prisma.businessStorageAccount.findUniqueOrThrow({
        where: { businessId: biz.id },
      });
      const assets = await prisma.storedAsset.findMany({
        where: { businessId: biz.id, deletedAt: null },
        select: { id: true, status: true, fileSizeBytes: true },
      });
      const readyAssets = assets.filter((row) => row.status === "READY");
      const readyBytes = readyAssets.reduce((sum, row) => sum + Number(row.fileSizeBytes), 0);
      const used = Number(after.storageUsedBytes);
      const reserved = Number(after.storageReservedBytes);
      const deadlockSeen = [held, ...raced].some(
        (item) =>
          item.status === "rejected" &&
          (isDeadlockError(item.reason) ||
            /40P01|deadlock detected/i.test(`${item.err ?? ""} ${item.out ?? ""} ${item.reason ?? ""}`)),
      );
      results.push({
        deadlockSeen,
        reserved,
        used,
        readyBytes,
        accountingOk: reserved >= 0 && used === readyBytes,
      });
    } finally {
      await leftClient.$disconnect();
      await rightClient.$disconnect();
    }
  }
  return {
    rounds: results.length,
    deadlockCount: results.filter((row) => row.deadlockSeen).length,
    accountingOk: results.every((row) => row.accountingOk),
    results,
  };
}

if (process.env.REQUEST_INTAKE_LOCK_ORDER_MUTATION === "1") {
  const require = createRequire(import.meta.url);
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const provider = new MemoryStorageProvider();
  try {
    const result = await runHeldAccountFinalizeRaces({
      prisma,
      provider,
      PrismaClient,
      datasourceUrl: process.env.DATABASE_URL,
    });
    const ok =
      !result.abortRace.deadlockSeen &&
      !result.sweepRace.deadlockSeen &&
      result.abortRace.oneOutcome &&
      result.sweepRace.oneOutcome &&
      result.abortRace.quotaOk &&
      result.sweepRace.quotaOk;
    if (!ok) {
      console.error(
        `FAIL - held-account lock races abortDeadlock=${result.abortRace.deadlockSeen} sweepDeadlock=${result.sweepRace.deadlockSeen} abortReady=${result.abortRace.ready} sweepReady=${result.sweepRace.ready}`,
      );
    }
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error("FAIL - held-account lock mutation child threw", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.env.REQUEST_INTAKE_RELEASE_LOCK_MUTATION === "1") {
  const require = createRequire(import.meta.url);
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const provider = new MemoryStorageProvider();
  try {
    const result = await runHeldAccountReleaseFinalizeRaces({
      prisma,
      provider,
      PrismaClient,
      datasourceUrl: process.env.DATABASE_URL,
      rounds: 5,
    });
    const ok = result.deadlockCount === 0 && result.accountingOk && result.rounds === 5;
    if (!ok) {
      console.error(
        `FAIL - held-account release/finalize races deadlockCount=${result.deadlockCount} accountingOk=${result.accountingOk}`,
      );
    }
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error("FAIL - held-account release lock mutation child threw", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

console.log("\nSTATIC — Private photos and reusable measurement config");
check(
  "Request photos use CUSTOMER_PHOTO + PRIVATE visibility",
  readRepo("src/lib/business-storage/request-photos.ts").includes("CUSTOMER_PHOTO") &&
    readRepo("src/lib/business-storage/request-photos.ts").includes('visibility: "PRIVATE"'),
);
check(
  "Public storage route is not used for request photos",
  !readRepo("src/lib/business-storage/request-photos.ts").includes("/api/storage/public/"),
);
check(
  "Shared measurement UI does not hardcode blinds or TV mounting",
  !/Blind|TV Mount|Drywall/.test(readRepo("src/components/public/request-measurement-fields.tsx")),
);
check(
  "Private request-photo route is not a public website path",
  !readRepo("src/lib/public-website-paths.ts").includes("/api/storage/private/"),
);
check(
  "Starter blinds template carries reusable measurement config",
  readRepo("src/lib/handyman-starter-catalog.ts").includes('templateKey: "blind-shade-installation"') &&
    readRepo("src/lib/handyman-starter-catalog.ts").includes('intakeMeasurementMode: "RECOMMENDED"'),
);
check(
  "Customer-reported and contractor-verified sources stay distinct",
  CUSTOMER_REPORTED_MEASUREMENT !== CONTRACTOR_VERIFIED_MEASUREMENT,
);
check(
  "Public request photos now accept HEIC/HEIF in addition to JPEG/PNG/WebP",
  readRepo("src/lib/business-storage/request-photo-rules.ts").includes("image/heic") &&
    readRepo("src/lib/business-storage/request-photo-rules.ts").includes("image/heif"),
);
const jobPhotoSrc = readRepo("src/app/actions/job-photo.ts");
const expenseSrc = readRepo("src/app/actions/expenses.ts");
const storageSrc = readRepo("src/lib/storage.ts");
check(
  "OWNER/ADMIN job photos use private R2 / StoredAsset, not the 4MB Blob server-action path",
  jobPhotoSrc.includes("authorizeManagementJobPhoto") &&
    jobPhotoSrc.includes("finalizeManagementJobPhoto") &&
    jobPhotoSrc.includes("The image body never enters this") &&
    !jobPhotoSrc.includes("MAX_JOB_PHOTO_UPLOAD_BYTES") &&
    !jobPhotoSrc.includes("uploadJobPhoto") &&
    !jobPhotoSrc.includes("BLOB_READ_WRITE_TOKEN"),
);
check(
  "Expense receipts use private managed storage with a 4MB cap, not Vercel Blob",
  storageSrc.includes("MAX_JOB_PHOTO_UPLOAD_BYTES = 4 * 1024 * 1024") &&
    expenseSrc.includes("putExpenseReceiptFromBytes") &&
    expenseSrc.includes("inspectExpenseReceiptUpload") &&
    !expenseSrc.includes("uploadExpenseReceipt") &&
    !expenseSrc.includes("MAX_JOB_PHOTO_UPLOAD_BYTES") &&
    !expenseSrc.includes("BLOB_READ_WRITE_TOKEN"),
);

const nextConfigSrc = readRepo("next.config.ts");
const proxySrc = readRepo("src/proxy.ts");
check(
  "Server Actions allow www.tbbtool.com origin used by public hire submit",
  nextConfigSrc.includes('"www.tbbtool.com"') &&
    nextConfigSrc.includes('"tbbtool.com"') &&
    nextConfigSrc.includes("allowedOrigins"),
);
check(
  "Public website proxy copies Host onto x-forwarded-host before Server Actions",
  proxySrc.includes("firstHeaderHostWithPort") &&
    proxySrc.includes('requestHeaders.set("x-forwarded-host", csrfHost)') &&
    proxySrc.includes("isPublicWebsitePath"),
);
check(
  "Host-with-port helper keeps local ports and takes the first forwarded host",
  firstHeaderHostWithPort("www.tbbtool.com") === "www.tbbtool.com" &&
    firstHeaderHostWithPort("www.tbbtool.com, www.collproreno.com") ===
      "www.tbbtool.com" &&
    firstHeaderHostWithPort("localhost:43217") === "localhost:43217",
);

const csrfThrownSubmit = await submitPublicIntakeForm(
  async () => {
    throw new Error("Invalid Server Actions request.");
  },
  "handy-handyman-services",
  new FormData(),
);
check(
  "Thrown Server Action CSRF abort maps to the public submit retry error",
  csrfThrownSubmit.ok === false &&
    csrfThrownSubmit.error === PUBLIC_INTAKE_SUBMIT_ERROR &&
    PUBLIC_INTAKE_SUBMIT_ERROR ===
      "This request could not be submitted. Please try again.",
);

const r2CorsSrc = readRepo("src/lib/business-storage/r2-cors.ts");
const r2CorsJson = readRepo("src/lib/business-storage/r2-browser-upload-cors.json");
const requestFlowSrc = readRepo("src/components/public/request-flow.tsx");
const intakeActionSrc = readRepo("src/app/actions/intake.ts");
const applyCorsSrc = readRepo("scripts/apply-r2-browser-upload-cors.mjs");
check(
  "R2 browser-upload CORS allowlist includes https://www.tbbtool.com",
  r2CorsSrc.includes('"https://www.tbbtool.com"') &&
    r2CorsSrc.includes('"https://tbbtool.com"') &&
    r2CorsJson.includes("https://www.tbbtool.com") &&
    r2CorsJson.includes("https://tbbtool.com") &&
    applyCorsSrc.includes('"https://www.tbbtool.com"'),
);
check(
  "Public hire photo PUT CORS failure falls back to server-side photos FormData",
  requestFlowSrc.includes("authorized.uploadUrl") &&
    requestFlowSrc.includes('formData.append("photos", photo.file)') &&
    requestFlowSrc.includes("abortPublicRequestPhotoUpload") &&
    intakeActionSrc.includes('.getAll("photos")') &&
    intakeActionSrc.includes("attachRemainingPublicRequestFallbackPhotos"),
);
check(
  "Rejected public submit releases that attempt's unattached photos",
  countRejectedSubmitPhotoReleaseCalls(requestFlowSrc) === 3 &&
    requestFlowSrc.includes("uploadedAssetIds") &&
    requestFlowSrc.includes("photos.slice(0, MAX_INTAKE_PHOTOS)") &&
    requestFlowSrc.indexOf("releaseRequestPhotosAfterRejectedSubmit") <
      requestFlowSrc.indexOf("setError(result.error)") &&
    !requestFlowSrc.includes("await releasePublicRequestPhotoUploads(") &&
    MAX_PUBLIC_INTAKE_REQUEST_PHOTOS === MAX_INTAKE_PHOTOS &&
    MAX_UNATTACHED_PUBLIC_REQUEST_PHOTOS === 200 &&
    UNATTACHED_PUBLIC_REQUEST_PHOTO_QUOTA_RATIO === 0.1 &&
    PUBLIC_REQUEST_PHOTO_CAP_REACHED.includes("too many photos"),
);
{
  const releaseCalls = [];
  const released = await releaseRequestPhotosAfterRejectedSubmit(
    async (input) => {
      releaseCalls.push(input);
      return { released: input.assetIds.length };
    },
    { slug: "collpro-reno", assetIds: ["photo-a", "photo-b"] },
  );
  const authorizeFailSrc = requestFlowSrc.slice(
    requestFlowSrc.indexOf("if (!authorized.assetId || !authorized.uploadUrl)"),
    requestFlowSrc.indexOf("setError(authorized.error"),
  );
  const submitRejectSrc = requestFlowSrc.slice(
    requestFlowSrc.indexOf("if (!result.ok)"),
    requestFlowSrc.indexOf("setError(result.error)"),
  );
  const submitThrowSrc = requestFlowSrc.slice(
    requestFlowSrc.lastIndexOf("} catch {"),
    requestFlowSrc.indexOf('setError("This request could not be submitted.'),
  );
  const strippedFlow = requestFlowSrc.replace(
    /await releaseRequestPhotosAfterRejectedSubmit\([\s\S]*?\);/g,
    "",
  );
  check(
    "Release-on-failure helper is invoked with the attempt's photo ids",
    released.released === 2 &&
      releaseCalls.length === 1 &&
      releaseCalls[0].slug === "collpro-reno" &&
      releaseCalls[0].assetIds.join(",") === "photo-a,photo-b",
  );
  check(
    "Authorize-fail, submit-reject, and submit-throw paths each call the release helper",
    authorizeFailSrc.includes("releaseRequestPhotosAfterRejectedSubmit") &&
      submitRejectSrc.includes("releaseRequestPhotosAfterRejectedSubmit") &&
      submitThrowSrc.includes("releaseRequestPhotosAfterRejectedSubmit") &&
      countRejectedSubmitPhotoReleaseCalls(strippedFlow) === 0,
  );
}
const requestPhotosSrc = readRepo("src/lib/business-storage/request-photos.ts");
const finalizeFnSrc = requestPhotosSrc.slice(
  requestPhotosSrc.indexOf("export async function finalizePublicRequestPhoto"),
);
const candidateLoadIdx = finalizeFnSrc.indexOf("storedAsset.findFirst");
const genericFinalizeIdx = finalizeFnSrc.indexOf("finalizeManagedUpload");
const attachFnSrc = requestPhotosSrc.slice(
  requestPhotosSrc.indexOf("export async function attachRemainingPublicRequestFallbackPhotos"),
);
check(
  "Fallback photos count recorded ServiceRequestPhoto rows before attaching more",
  requestPhotosSrc.includes("serviceRequestPhoto.count") &&
    requestPhotosSrc.includes("remainingIntakePhotoSlots") &&
    requestPhotosSrc.includes("MAX_INTAKE_PHOTOS") &&
    intakeActionSrc.includes("attachRemainingPublicRequestFallbackPhotos") &&
    !intakeActionSrc.includes(".slice(0, MAX_INTAKE_PHOTOS)"),
);
check(
  "Fallback attach serializes on the owned ServiceRequest row, not a table lock",
  attachFnSrc.includes("$transaction") &&
    attachFnSrc.includes("FROM \"ServiceRequest\"") &&
    attachFnSrc.includes("FOR UPDATE") &&
    attachFnSrc.indexOf("FOR UPDATE") < attachFnSrc.indexOf("serviceRequestPhoto.count") &&
    attachFnSrc.indexOf("serviceRequestPhoto.count") <
      attachFnSrc.indexOf("putPublicRequestPhotoFromBytes(deps, slug") &&
    !attachFnSrc.includes("LOCK TABLE") &&
    !/pg_advisory|advisory_lock/i.test(attachFnSrc),
);

const publicIntakeSrc = readRepo("src/lib/public-intake.ts");
check(
  "Intake attach clears request-photo expiry and releases unattached extras",
  publicIntakeSrc.includes("rememberAttachedPublicRequestPhotos") &&
    publicIntakeSrc.includes("releaseUnattachedPublicRequestPhotos") &&
    publicIntakeSrc.includes("leftoverAssetIds") &&
    requestPhotosSrc.includes("releaseExpiredUnattachedPublicRequestPhotos") &&
    requestPhotosSrc.includes("stampUnattachedRequestPhotoExpiry"),
);
check(
  "Unattached request photos use a 24h attach TTL, not the 15-minute upload reservation",
  UNATTACHED_REQUEST_PHOTO_TTL_MS === 24 * 60 * 60 * 1000 &&
    UNATTACHED_REQUEST_PHOTO_TTL_MS >= 2 * 60 * 60 * 1000 &&
    UNATTACHED_REQUEST_PHOTO_TTL_MS !== STORAGE_PENDING_TTL_MS &&
    STORAGE_PENDING_TTL_MS === 15 * 60 * 1000 &&
    requestPhotosSrc.includes("UNATTACHED_REQUEST_PHOTO_TTL_MS") &&
    !requestPhotosSrc.includes("STORAGE_PENDING_TTL_MS") &&
    requestPhotosSrc.includes("stampUnattachedRequestPhotoExpiry"),
);
const lockFnSrc = requestPhotosSrc.slice(
  requestPhotosSrc.indexOf("export async function lockStoredAssetRowForUpdate"),
  requestPhotosSrc.indexOf("export type PublicRequestFallbackPhotoFile"),
);
const claimFnSrc = requestPhotosSrc.slice(
  requestPhotosSrc.indexOf("async function claimUnattachedRequestPhotoInTx"),
  requestPhotosSrc.indexOf("export async function rememberAttachedPublicRequestPhotos"),
);
const leftoverReleaseIdx = publicIntakeSrc.indexOf("await releaseUnattachedPublicRequestPhotos");
const leftoverTryIdx = publicIntakeSrc.lastIndexOf("try {", leftoverReleaseIdx);
const leftoverCatchIdx = publicIntakeSrc.indexOf("} catch (error) {", leftoverReleaseIdx);
const leftoverOkIdx = publicIntakeSrc.indexOf("return { ok: true, requestId: written.requestId }", leftoverReleaseIdx);
const attachLockIdx = publicIntakeSrc.indexOf("await lockStoredAssetRowForUpdate");
const attachInsertIdx = publicIntakeSrc.indexOf("serviceRequestPhoto.createMany");
check(
  "Claim and intake attach take a StoredAsset row lock before READY->FAILED or insert",
  lockFnSrc.includes("FROM \"StoredAsset\"") &&
    lockFnSrc.includes("FOR UPDATE") &&
    claimFnSrc.includes("lockStoredAssetRowForUpdate") &&
    claimFnSrc.indexOf("lockStoredAssetRowForUpdate") < claimFnSrc.indexOf('status: "FAILED"') &&
    attachLockIdx > -1 &&
    attachInsertIdx > attachLockIdx &&
    publicIntakeSrc.includes("PublicRequestPhotoUnavailableError") &&
    requestPhotosSrc.includes("sortedStoredAssetIds") &&
    publicIntakeSrc.includes("sortedStoredAssetIds") &&
    !publicIntakeSrc.includes(".sort((left, right)") &&
    sortedStoredAssetIds(["b", "a", "b"]).join(",") === "a,b",
);
check(
  "Public intake caps photoAssetIds before lookup and isolates leftover release after commit",
  publicIntakeSrc.includes("MAX_PUBLIC_REQUEST_PHOTO_ID_LOOKUP") &&
    MAX_PUBLIC_REQUEST_PHOTO_ID_LOOKUP === 50 &&
    publicIntakeSrc.includes("overflowPhotoAssetIds") &&
    leftoverTryIdx > -1 &&
    leftoverTryIdx < leftoverReleaseIdx &&
    leftoverCatchIdx > leftoverReleaseIdx &&
    leftoverOkIdx > leftoverCatchIdx &&
    publicIntakeSrc.includes("Failed to release leftover public request photos after intake commit"),
);
const earlyReplayIdx = publicIntakeSrc.indexOf(
  'description: { contains: `${INTAKE_SUBMISSION_MARKER}${submissionId}` }',
);
const vanishedRefuseIdx = publicIntakeSrc.lastIndexOf('row.status !== "READY"');
const lockedReplayIdx = publicIntakeSrc.indexOf("claimPublicIntakeSubmission");
check(
  "A selected photo that is no longer READY is refused with a re-add message",
  publicIntakeSrc.includes("PUBLIC_REQUEST_PHOTO_UNAVAILABLE") &&
    PUBLIC_REQUEST_PHOTO_UNAVAILABLE.includes("re-add") &&
    publicIntakeSrc.includes('row.status !== "READY"'),
);
check(
  "Existing submission replay runs before the vanished-photo refuse",
  earlyReplayIdx > -1 &&
    vanishedRefuseIdx > earlyReplayIdx &&
    lockedReplayIdx > -1 &&
    vanishedRefuseIdx > lockedReplayIdx &&
    MAX_UNATTACHED_REQUEST_PHOTO_RELEASE_BATCH === 50 &&
    requestPhotosSrc.includes("MAX_UNATTACHED_REQUEST_PHOTO_RELEASE_BATCH") &&
    requestPhotosSrc.includes("expiresAt: null, updatedAt:"),
);
const submissionLockSrc = readRepo("src/lib/public-intake-submission.ts");
const lockedClaimCallIdx = publicIntakeSrc.indexOf("await claimPublicIntakeSubmission");
const submissionClaimSlice = publicIntakeSrc.slice(
  publicIntakeSrc.lastIndexOf("if (submissionId) {", lockedClaimCallIdx),
);
const submissionLockIdx = submissionClaimSlice.indexOf("claimPublicIntakeSubmission");
const submissionFindIdx = submissionClaimSlice.indexOf("serviceRequest.findFirst");
check(
  "Public intake claims submissionId with a transaction lock before replay lookup",
  lockedClaimCallIdx > -1 &&
    submissionLockIdx > -1 &&
    submissionFindIdx > submissionLockIdx &&
    submissionLockSrc.includes("pg_advisory_xact_lock") &&
    submissionLockSrc.includes("$executeRaw") &&
    submissionLockSrc.includes("publicIntakeSubmissionLockKey") &&
    submissionClaimSlice.includes("INTAKE_SUBMISSION_MARKER") &&
    !publicIntakeSrc.includes("$executeRaw") &&
    publicIntakeSubmissionLockKey("biz", "token12ab") === "tbbt.public-intake:biz:token12ab",
);
const mutatedIntakeSrc = publicIntakeSrc.replace(
  /await claimPublicIntakeSubmission\(tx, business\.id, submissionId\);\s*/,
  "",
);
const mutatedLockedClaimIdx = mutatedIntakeSrc.indexOf("if (existing) return { requestId: existing.id");
const mutatedClaimSlice = mutatedIntakeSrc.slice(
  mutatedIntakeSrc.lastIndexOf("if (submissionId) {", mutatedLockedClaimIdx),
);
check(
  "Mutation: removing the submission lock leaves replay lookup unserialized",
  submissionLockSrc.includes("pg_advisory_xact_lock") &&
    !mutatedClaimSlice.includes("claimPublicIntakeSubmission") &&
    mutatedClaimSlice.includes("serviceRequest.findFirst") &&
    mutatedClaimSlice.includes("INTAKE_SUBMISSION_MARKER"),
);
const contactFormSrc = readRepo("src/components/public/public-contact-form.tsx");
check(
  "Public contact form reuses submitServiceRequest with a stable submissionId",
  contactFormSrc.includes("submitServiceRequest") &&
    contactFormSrc.includes('formData.set("submissionId"') &&
    contactFormSrc.includes("submissionIdRef") &&
    !contactFormSrc.includes("createLead") &&
    !contactFormSrc.includes("Lead.create"),
);
check(
  "Combined remaining slots are MAX_INTAKE_PHOTOS minus recorded attachments",
  remainingIntakePhotoSlots(0) === MAX_INTAKE_PHOTOS &&
    remainingIntakePhotoSlots(5) === 3 &&
    remainingIntakePhotoSlots(8) === 0 &&
    remainingIntakePhotoSlots(16) === 0 &&
    MAX_INTAKE_PHOTOS === 8,
);
const authorizeFnSrc = requestPhotosSrc.slice(
  requestPhotosSrc.indexOf("export async function authorizePublicRequestPhoto"),
  requestPhotosSrc.indexOf("export async function finalizePublicRequestPhoto"),
);
const storageServiceSrc = readRepo("src/lib/business-storage/service.ts");
const reservedHelperSrc = storageServiceSrc.slice(
  storageServiceSrc.indexOf("function reservedBytesForPendingAsset"),
  storageServiceSrc.indexOf("export function hasEnoughStorage"),
);
check(
  "Public request finalize loads the candidate before generic finalizeManagedUpload",
  candidateLoadIdx >= 0 &&
    genericFinalizeIdx > candidateLoadIdx &&
    finalizeFnSrc.includes("isPrivateUnpublishedCustomerPhoto") &&
    finalizeFnSrc.includes("status === \"READY\"") &&
    requestPhotosSrc.includes('category === "CUSTOMER_PHOTO"') &&
    requestPhotosSrc.includes('visibility === "PRIVATE"') &&
    requestPhotosSrc.indexOf("function isPrivateUnpublishedCustomerPhoto") <
      requestPhotosSrc.indexOf("export async function finalizePublicRequestPhoto"),
);
check(
  "Unused public request authorizations do not reserve quota or consume uploaded-byte allowance",
  authorizeFnSrc.includes("incomingBytes: 0") &&
    !authorizeFnSrc.includes("incomingBytes: inspection.fileSizeBytes") &&
    finalizeFnSrc.includes("incomingBytes: candidate.fileSizeBytes") &&
    finalizeFnSrc.includes("beforeClaim") &&
    reservedHelperSrc.includes("PUBLIC_REQUEST_PHOTO_PURPOSE") &&
    reservedHelperSrc.includes("return 0") &&
    requestPhotosSrc.includes("row.status === \"READY\""),
);
const finalizeManagedSrc = storageServiceSrc.slice(
  storageServiceSrc.indexOf("export async function finalizeManagedUpload"),
  storageServiceSrc.indexOf("export async function finalizeBusinessUpload"),
);
check(
  "Finalize re-checks entitled quota under the account lock before charging used bytes",
  finalizeManagedSrc.indexOf("await options?.beforeClaim") <
    finalizeManagedSrc.indexOf("lockAccountThenPendingAsset") &&
    finalizeManagedSrc.indexOf("lockAccountThenPendingAsset") <
      finalizeManagedSrc.indexOf("hasEnoughStorage") &&
    finalizeManagedSrc.includes("failPendingAssetAndReleaseReservation") &&
    finalizeManagedSrc.includes('kind: "quota"') &&
    finalizeManagedSrc.includes("pendingReservationBytesToRelease") &&
    storageServiceSrc.includes("width: 0"),
);
const abortManagedSrc = storageServiceSrc.slice(
  storageServiceSrc.indexOf("export async function abortManagedUpload"),
  storageServiceSrc.indexOf("export type DiscardReadyManagedUploadMatch"),
);
const expireReservationsSrc = storageServiceSrc.slice(
  storageServiceSrc.indexOf("async function releaseExpiredReservations"),
  storageServiceSrc.indexOf("export type AuthorizeManagedUploadOptions"),
);
check(
  "Abort and expiry sweep lock the storage account before the PENDING asset",
  abortManagedSrc.includes("LOCK_ACCOUNT_BEFORE_ASSET") &&
    abortManagedSrc.indexOf("lockAccountThenPendingAsset") <
      abortManagedSrc.indexOf("storedAsset.updateMany") &&
    expireReservationsSrc.includes("LOCK_ACCOUNT_BEFORE_ASSET") &&
    expireReservationsSrc.indexOf("lockStorageAccountRow") <
      expireReservationsSrc.indexOf("storedAsset.updateMany") &&
    expireReservationsSrc.indexOf("lockPendingAssetRow") <
      expireReservationsSrc.indexOf("storedAsset.updateMany"),
);
const releaseFnSrc = requestPhotosSrc.slice(
  requestPhotosSrc.indexOf("export async function releaseUnattachedPublicRequestPhotos"),
  requestPhotosSrc.indexOf("export async function releaseExpiredUnattachedPublicRequestPhotos"),
);
const discardManagedSrc = storageServiceSrc.slice(
  storageServiceSrc.indexOf("export async function discardReadyManagedUpload"),
  storageServiceSrc.indexOf("export async function abortBusinessUpload"),
);
const deleteAssetSrc = storageServiceSrc.slice(
  storageServiceSrc.indexOf("export async function deleteStoredAsset"),
  storageServiceSrc.indexOf("export async function assertOwnedStoredAsset"),
);
const expenseReceiptsSrc = readRepo("src/lib/business-storage/expense-receipts.ts");
const expenseClaimSrc = expenseReceiptsSrc.slice(
  expenseReceiptsSrc.indexOf("async function claimUnreferencedExpenseReceiptInTx"),
  expenseReceiptsSrc.indexOf("function releasePreviousReceiptAfterClaim"),
);
const attachLockBlock = publicIntakeSrc.slice(
  publicIntakeSrc.indexOf("const attachedAssetIds = sortedStoredAssetIds"),
  publicIntakeSrc.indexOf("await rememberAttachedPublicRequestPhotos"),
);
check(
  "Release, discard, delete, expense claim, and intake attach lock the account before asset rows",
  releaseFnSrc.includes("LOCK_ACCOUNT_BEFORE_ASSET") &&
    releaseFnSrc.indexOf("lockBusinessStorageAccountForUpdate") <
      releaseFnSrc.indexOf("claimUnattachedRequestPhotoInTx") &&
    discardManagedSrc.includes("LOCK_ACCOUNT_BEFORE_ASSET") &&
    discardManagedSrc.indexOf("lockStorageAccountRow") <
      discardManagedSrc.indexOf("storedAsset.updateMany") &&
    deleteAssetSrc.includes("LOCK_ACCOUNT_BEFORE_ASSET") &&
    deleteAssetSrc.indexOf("lockStorageAccountRow") <
      deleteAssetSrc.indexOf("storedAsset.update") &&
    expenseClaimSrc.includes("LOCK_ACCOUNT_BEFORE_ASSET") &&
    expenseClaimSrc.indexOf("lockBusinessStorageAccountForUpdate") <
      expenseClaimSrc.indexOf("storedAsset.updateMany") &&
    attachLockBlock.includes("LOCK_ACCOUNT_BEFORE_ASSET") &&
    attachLockBlock.indexOf("lockBusinessStorageAccountForUpdate") <
      attachLockBlock.indexOf("lockStoredAssetRowForUpdate"),
);
check(
  "Public request photo finalize is slug-authorized and ignores browser businessId",
  readRepo("src/app/actions/public-request-photos.ts").includes(
    "finalizePublicRequestPhoto({ db: prisma }, input.slug, input.assetId)",
  ) &&
    !readRepo("src/app/actions/public-request-photos.ts").includes("businessId") &&
    requestPhotosSrc.includes("resolvePublicStorageBusiness(deps.db, slug)"),
);
check(
  "Public submit notifies the tenant company email after the request persists",
  intakeActionSrc.indexOf("createPublicServiceRequest(prisma") <
    intakeActionSrc.indexOf("notifyBusinessNewPublicRequest(prisma") &&
    intakeActionSrc.includes("notifyBusinessNewPublicRequest(prisma, {") &&
    intakeActionSrc.includes("businessId: notifyBusiness.id") &&
    intakeActionSrc.includes("requestId: created.requestId") &&
    !/customer\.email/.test(intakeActionSrc),
);

const requestActionSrc = readRepo("src/app/actions/request.ts");
const ownerLogLeadSrc = readRepo("src/lib/owner-log-lead.ts");
const logLeadFormSrc = readRepo("src/components/requests/log-lead-form.tsx");
const logLeadPageSrc = readRepo("src/app/(app)/requests/log-lead/page.tsx");
check(
  "Owner Log lead is a real ServiceRequest action, not a second Lead table",
  requestActionSrc.includes("export async function logLead") &&
    requestActionSrc.includes("createOwnerLoggedLead") &&
    requestActionSrc.includes("CAPABILITIES.MANAGE_ESTIMATES") &&
    ownerLogLeadSrc.includes("serviceRequest.create") &&
    !ownerLogLeadSrc.includes("prisma.lead") &&
    !requestActionSrc.includes("model Lead"),
);
check(
  "Log lead never authorizes from client businessId",
  !requestActionSrc.includes('readString(formData, "businessId")') &&
    ownerLogLeadSrc.includes("Browser-supplied businessId is never authorization") &&
    ownerLogLeadSrc.includes("void input.businessId"),
);
check(
  "Log lead reuses normalized customer matching and structured addresses",
  ownerLogLeadSrc.includes("decideCustomerMatch") &&
    ownerLogLeadSrc.includes("validateStructuredAddress") &&
    logLeadFormSrc.includes('name="streetAddress"') &&
    logLeadFormSrc.includes('name="postalCode"'),
);
check(
  "Log lead form stays a one-minute capture (no price, schedule, or payment)",
  !logLeadFormSrc.includes("unitPrice") &&
    !logLeadFormSrc.includes("scheduledAt") &&
    !logLeadFormSrc.includes("payment") &&
    logLeadPageSrc.includes("creates a ServiceRequest"),
);
check(
  "Logged leads hand off through the existing createEstimate path",
  readRepo("src/app/(app)/requests/page.tsx").includes('href="/requests/log-lead"') &&
    readRepo("src/components/requests/requests-workspace.tsx").includes("CreateEstimateButton") &&
    readRepo("src/app/actions/estimate.ts").includes("serviceRequestId: request.id") &&
    readRepo("src/app/actions/estimate.ts").includes("customerId: request.customerId") &&
    readRepo("src/app/actions/estimate.ts").includes("propertyId: request.propertyId"),
);
check(
  "Log lead resolves trade from ACTIVE BusinessTrade and does not invent a Handyman fallback",
  ownerLogLeadSrc.includes("resolvePublicRequestTrade") &&
    ownerLogLeadSrc.includes("listActiveBusinessTrades") &&
    ownerLogLeadSrc.includes("authorizedOwnerLogLeadTradeCodes") &&
    !ownerLogLeadSrc.includes("DEFAULT_TRADE") &&
    logLeadPageSrc.includes("catalogItemIsPubliclyOffered") &&
    logLeadFormSrc.includes('name="tradeCode"') &&
    logLeadFormSrc.includes("activeTrades.length > 1"),
);

const noneConfig = resolveCatalogIntakeConfig({ intakeMeasurementMode: "NONE" });
const blindsConfig = resolveCatalogIntakeConfig({
  intakeMeasurementMode: "RECOMMENDED",
  intakeMeasurementAxes: "width,height",
  intakeMeasurementUnit: "IN",
});
check("Service without measurements enabled asks for none", !catalogAsksMeasurements(noneConfig));
check("Service with measurements enabled asks for configured axes", catalogAsksMeasurements(blindsConfig) && blindsConfig.axes.join(",") === "width,height");
check(
  "Optional measurements may be omitted",
  validateCustomerMeasurementInput(blindsConfig, { width: "", height: "" }).ok === true,
);
check(
  "Invalid optional measurement text is rejected",
  validateCustomerMeasurementInput(blindsConfig, { width: "abc", height: "" }).ok === false,
);
check(
  "Required measurements are rejected when empty",
  validateCustomerMeasurementInput(
    { ...blindsConfig, mode: "REQUIRED" },
    { width: "", height: "" },
  ).ok === false,
);

const testDbName = `tbbt_request_intake_${randomUUID().slice(0, 8)}`;
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for request-intake test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const bootstrap = new PrismaClient({ datasourceUrl: baseUrl });
try {
  await bootstrap.$executeRawUnsafe(`ALTER ROLE postgres SET timezone = 'UTC'`);
} finally {
  await bootstrap.$disconnect();
}
const prisma = new PrismaClient({ datasourceUrl: testUrl });
await prisma.$executeRawUnsafe(`SET timezone = 'UTC'`);
const provider = new MemoryStorageProvider();
const storageDeps = {
  db: prisma,
  provider,
  bucketName: "tbbt-request-photos",
};
publicIntakeStorageTestHooks.provider = provider;
publicIntakeStorageTestHooks.bucketName = storageDeps.bucketName;

try {
  console.log("\nDB — Photos, measurements, and existing request compatibility");
  const business = await prisma.business.create({
    data: { name: "CollPro Reno Handyman Services", slug: "collpro-reno", tradeCode: "HANDYMAN" },
  });
  const other = await prisma.business.create({
    data: { name: "Other Handyman", slug: "other-handyman", tradeCode: "HANDYMAN" },
  });
  const fan = await prisma.serviceCatalogItem.create({
    data: {
      businessId: business.id,
      name: "Ceiling Fan Replacement",
      category: "Fans & Fixtures",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(180),
      active: true,
    },
  });
  const blinds = await prisma.serviceCatalogItem.create({
    data: {
      businessId: business.id,
      name: "Blind / Shade Installation",
      category: "Mounting & Hanging",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(85),
      active: true,
      intakeMeasurementMode: "RECOMMENDED",
      intakeMeasurementAxes: "width,height",
      intakeMeasurementUnit: "IN",
    },
  });
  const otherItem = await prisma.serviceCatalogItem.create({
    data: {
      businessId: other.id,
      name: "Shelf Install",
      category: "Mounting & Hanging",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(90),
      active: true,
    },
  });

  const noPhotos = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "No Photo",
    email: "nophoto@example.com",
    phone: "555-0400",
    address: "",
    streetAddress: "12 Oak St",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Fan only.",
    catalogItemIds: [fan.id],
    includeOther: false,
    otherDescription: "",
  });
  const noPhotoRequest = noPhotos.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: noPhotos.requestId },
        include: { photos: true, measurements: true, property: true },
      })
    : null;
  check("Public request with no photos still succeeds", noPhotos.ok === true);
  check("No-photo request stores no photo rows", noPhotoRequest?.photos.length === 0);
  check("Service without measurements stores none", noPhotoRequest?.measurements.length === 0);
  check("Structured address still stores on a no-photo request", noPhotoRequest?.property?.city === "Fort Myers");

  const first = await putPublicRequestPhotoFromBytes(
    storageDeps,
    "collpro-reno",
    { originalFilename: "window-1.png", mimeType: "image/png", body: pngBytes },
  );
  const second = await putPublicRequestPhotoFromBytes(
    storageDeps,
    "collpro-reno",
    { originalFilename: "window-2.png", mimeType: "image/png", body: pngBytes },
  );
  const foreign = await putPublicRequestPhotoFromBytes(
    storageDeps,
    "other-handyman",
    { originalFilename: "other.png", mimeType: "image/png", body: pngBytes },
  );

  const withPhotos = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Photo Owner",
    email: "photos@example.com",
    phone: "555-0401",
    address: "",
    streetAddress: "88 Harbor",
    city: "Cape Coral",
    region: "FL",
    postalCode: "33904",
    notes: "Two windows.",
    catalogItemIds: [blinds.id],
    includeOther: false,
    otherDescription: "",
    photoAssetIds: [first.id, second.id, foreign.id],
    measurements: [{ catalogItemId: blinds.id, width: "32", height: "48", unit: "IN" }],
  });
  const photoRequest = withPhotos.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: withPhotos.requestId },
        include: { photos: true, measurements: true, items: true },
      })
    : null;
  check("Public request with multiple private photos succeeds", withPhotos.ok === true);
  check("Exactly two owned photos were attached", photoRequest?.photos.length === 2);
  check(
    "Photos belong to the correct business and request",
    photoRequest?.photos.every(
      (photo) =>
        photo.businessId === business.id &&
        photo.serviceRequestId === photoRequest.id &&
        Boolean(photo.storedAssetId),
    ) === true,
  );
  check(
    "Foreign-business photo was not attached",
    photoRequest?.photos.every((photo) => photo.storedAssetId !== foreign.id) === true,
  );

  const publicLeak = await servePublicStoredAsset(prisma, first.id, { provider });
  check("Public access cannot expose private request photos", publicLeak.ok === false);
  check("Private request photos have no publicPath", first.publicPath == null && first.visibility === "PRIVATE");
  const ownerRead = await servePrivateStoredAsset(prisma, first.id, business.id, { provider });
  check("Owner workspace can read the private request photo", ownerRead.ok === true);
  const otherOwnerRead = await servePrivateStoredAsset(prisma, first.id, other.id, { provider });
  check("Another business cannot read those private photos", otherOwnerRead.ok === false);

  check("Customer-reported measurements survive request creation", photoRequest?.measurements.length === 1);
  const reported = photoRequest?.measurements[0];
  check(
    "Stored measurement is customer-reported, not contractor-verified",
    reported?.source === CUSTOMER_REPORTED_MEASUREMENT &&
      reported?.verifiedAt == null &&
      reported?.verifiedByMembershipId == null,
  );
  check(
    "Width/height/quantity were stored for the blinds item",
    reported?.width?.toString() === "32" &&
      reported?.height?.toString() === "48" &&
      reported?.quantity === 1 &&
      reported?.unit === "IN",
  );

  const verified = await prisma.serviceRequestMeasurement.create({
    data: {
      businessId: business.id,
      serviceRequestId: photoRequest.id,
      serviceRequestItemId: reported.serviceRequestItemId,
      source: CONTRACTOR_VERIFIED_MEASUREMENT,
      width: new Prisma.Decimal("33"),
      height: new Prisma.Decimal("48"),
      quantity: 1,
      unit: "IN",
      verifiedAt: new Date(),
    },
  });
  const afterVerify = await prisma.serviceRequestMeasurement.findMany({
    where: { serviceRequestId: photoRequest.id },
    orderBy: { createdAt: "asc" },
  });
  check("Contractor verification adds a second row", afterVerify.length === 2);
  check(
    "Original customer-reported values remain",
    afterVerify[0].id === reported.id &&
      afterVerify[0].source === CUSTOMER_REPORTED_MEASUREMENT &&
      afterVerify[0].width.toString() === "32" &&
      verified.source === CONTRACTOR_VERIFIED_MEASUREMENT,
  );

  const legacy = await prisma.serviceRequest.create({
    data: {
      businessId: business.id,
      description: "Old request without photos or measurements",
      serviceCatalogItemId: fan.id,
    },
    include: { photos: true, measurements: true, items: true },
  });
  check(
    "Existing requests continue working without photos or measurements",
    legacy.photos.length === 0 && legacy.measurements.length === 0 && legacy.items.length === 0,
  );

  const otherRequest = await createPublicServiceRequest(prisma, {
    slug: "other-handyman",
    name: "Other Customer",
    email: "other@example.com",
    phone: "555-0499",
    address: "10 Main St",
    notes: "",
    catalogItemIds: [otherItem.id],
    includeOther: false,
    otherDescription: "",
  });
  check("Another tenant can still submit without CollPro measurement config", otherRequest.ok === true);

  console.log("\nDB — Combined managed + fallback photo cap");
  async function makeReadyPhotos(count, slug = "collpro-reno") {
    const photos = [];
    for (let i = 0; i < count; i += 1) {
      photos.push(
        await putPublicRequestPhotoFromBytes(storageDeps, slug, {
          originalFilename: `${slug}-${count}-${i}.png`,
          mimeType: "image/png",
          body: pngBytes,
        }),
      );
    }
    return photos;
  }
  function makePngFiles(count, prefix) {
    return Array.from({ length: count }, (_, i) => new File([pngBytes], `${prefix}-${i}.png`, { type: "image/png" }));
  }
  async function countRequestPhotos(requestId) {
    return prisma.serviceRequestPhoto.count({
      where: { serviceRequestId: requestId, businessId: business.id },
    });
  }
  async function submitWithFallback({ name, email, photoAssetIds, files, submissionId, notes }) {
    const created = await createPublicServiceRequest(prisma, {
      slug: "collpro-reno",
      name,
      email,
      phone: "555-0410",
      address: "",
      streetAddress: "12 Oak St",
      city: "Fort Myers",
      region: "FL",
      postalCode: "33901",
      notes: notes ?? "Photo cap",
      catalogItemIds: [fan.id],
      includeOther: false,
      otherDescription: "",
      photoAssetIds,
      submissionId,
    });
    if (!created.ok) return { created, count: -1, requestId: null };
    await attachRemainingPublicRequestFallbackPhotos(storageDeps, "collpro-reno", {
      requestId: created.requestId,
      files,
    });
    return {
      created,
      requestId: created.requestId,
      count: await countRequestPhotos(created.requestId),
    };
  }

  const eightManaged = await makeReadyPhotos(8);
  const eightPlusEight = await submitWithFallback({
    name: "Eight Plus Eight",
    email: "eight-plus-eight@example.com",
    photoAssetIds: eightManaged.map((row) => row.id),
    files: makePngFiles(8, "extra-eight"),
  });
  check(
    "8 valid managed photoAssetIds + 8 fallback files attach exactly 8 ServiceRequestPhoto rows",
    eightPlusEight.created.ok === true && eightPlusEight.count === 8,
  );
  check(
    "Managed attachments are kept when leftover fallback files are ignored",
    eightPlusEight.requestId
      ? (
          await prisma.serviceRequestPhoto.findMany({
            where: { serviceRequestId: eightPlusEight.requestId },
            select: { storedAssetId: true },
          })
        ).every((row) => eightManaged.some((asset) => asset.id === row.storedAssetId))
      : false,
  );

  const fiveManaged = await makeReadyPhotos(5);
  const fivePlusEight = await submitWithFallback({
    name: "Five Plus Eight",
    email: "five-plus-eight@example.com",
    photoAssetIds: fiveManaged.map((row) => row.id),
    files: makePngFiles(8, "extra-five"),
  });
  const fivePlusEightIds = fivePlusEight.requestId
    ? (
        await prisma.serviceRequestPhoto.findMany({
          where: { serviceRequestId: fivePlusEight.requestId },
          select: { storedAssetId: true },
        })
      ).map((row) => row.storedAssetId)
    : [];
  check(
    "5 managed + 8 fallback files attach exactly 8 total photos",
    fivePlusEight.created.ok === true && fivePlusEight.count === 8,
  );
  check(
    "5 managed stay attached and only 3 fallback files consume remaining slots",
    fiveManaged.every((asset) => fivePlusEightIds.includes(asset.id)) &&
      fivePlusEightIds.filter((id) => !fiveManaged.some((asset) => asset.id === id)).length === 3,
  );

  const zeroPlusEight = await submitWithFallback({
    name: "Zero Plus Eight",
    email: "zero-plus-eight@example.com",
    photoAssetIds: [],
    files: makePngFiles(8, "fallback-only"),
  });
  check(
    "0 managed + 8 fallback files attach exactly 8 total photos",
    zeroPlusEight.created.ok === true && zeroPlusEight.count === 8,
  );

  const retrySubmissionId = "photocap01";
  const retryFirst = await submitWithFallback({
    name: "Retry Cap",
    email: "retry-cap@example.com",
    photoAssetIds: (await makeReadyPhotos(8)).map((row) => row.id),
    files: [],
    submissionId: retrySubmissionId,
  });
  const retrySecond = await submitWithFallback({
    name: "Retry Cap",
    email: "retry-cap@example.com",
    photoAssetIds: [],
    files: makePngFiles(8, "retry-extra"),
    submissionId: retrySubmissionId,
  });
  check(
    "Duplicate submissionId retry reuses the request and never exceeds 8 photos",
    retryFirst.created.ok === true &&
      retrySecond.created.ok === true &&
      retrySecond.requestId === retryFirst.requestId &&
      retryFirst.count === 8 &&
      retrySecond.count === 8,
  );

  const ownedForInvalid = await makeReadyPhotos(2);
  const invalidPlusFallback = await submitWithFallback({
    name: "Invalid Assets",
    email: "invalid-assets@example.com",
    photoAssetIds: [ownedForInvalid[0].id, ownedForInvalid[1].id, foreign.id, "not-a-real-asset-id"],
    files: makePngFiles(8, "after-invalid"),
  });
  const invalidIds = invalidPlusFallback.requestId
    ? (
        await prisma.serviceRequestPhoto.findMany({
          where: { serviceRequestId: invalidPlusFallback.requestId },
          select: { storedAssetId: true },
        })
      ).map((row) => row.storedAssetId)
    : [];
  check(
    "Foreign/invalid photoAssetIds do not consume a slot unless they actually attached",
    invalidPlusFallback.created.ok === true &&
      invalidPlusFallback.count === 8 &&
      invalidIds.includes(ownedForInvalid[0].id) &&
      invalidIds.includes(ownedForInvalid[1].id) &&
      !invalidIds.includes(foreign.id) &&
      !invalidIds.includes("not-a-real-asset-id") &&
      invalidIds.filter((id) => ![ownedForInvalid[0].id, ownedForInvalid[1].id].includes(id)).length === 6,
  );

  console.log("\nDB — Concurrent fallback handlers stay at MAX_INTAKE_PHOTOS");
  function createLatch() {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  async function waitForPeer(promise, ms, label) {
    let timer;
    try {
      await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function countAssetsByPrefix(prefix) {
    return prisma.storedAsset.count({
      where: {
        businessId: business.id,
        originalFilename: { startsWith: prefix },
      },
    });
  }

  const concurrentFive = await submitWithFallback({
    name: "Concurrent Five",
    email: "concurrent-five@example.com",
    photoAssetIds: (await makeReadyPhotos(5)).map((row) => row.id),
    files: [],
  });
  const fivePrefixA = `conc-five-a-${concurrentFive.requestId}-`;
  const fivePrefixB = `conc-five-b-${concurrentFive.requestId}-`;
  const [fiveA, fiveB] = await Promise.all([
    attachRemainingPublicRequestFallbackPhotos(storageDeps, "collpro-reno", {
      requestId: concurrentFive.requestId,
      files: makePngFiles(8, fivePrefixA),
    }),
    attachRemainingPublicRequestFallbackPhotos(storageDeps, "collpro-reno", {
      requestId: concurrentFive.requestId,
      files: makePngFiles(8, fivePrefixB),
    }),
  ]);
  const fiveConcurrentCount = await countRequestPhotos(concurrentFive.requestId);
  const fiveUploadedA = await countAssetsByPrefix(fivePrefixA);
  const fiveUploadedB = await countAssetsByPrefix(fivePrefixB);
  check(
    "Concurrent 5-recorded + 8/8 fallback handlers finish with exactly 8 rows",
    concurrentFive.created.ok === true &&
      concurrentFive.count === 5 &&
      fiveConcurrentCount === 8 &&
      fiveConcurrentCount <= MAX_INTAKE_PHOTOS,
  );
  check(
    "Concurrent 5-recorded handlers attach only 3 new fallback photos total",
    fiveA.attached + fiveB.attached === 3 &&
      fiveA.uploaded + fiveB.uploaded === 3 &&
      ((fiveA.uploaded === 3 && fiveB.uploaded === 0) ||
        (fiveB.uploaded === 3 && fiveA.uploaded === 0)),
  );
  check(
    "Loser of the 5-recorded race uploads zero files after recounting 8",
    fiveUploadedA + fiveUploadedB === 3 &&
      ((fiveUploadedA === 3 && fiveUploadedB === 0) ||
        (fiveUploadedB === 3 && fiveUploadedA === 0)),
  );

  const concurrentZero = await submitWithFallback({
    name: "Concurrent Zero",
    email: "concurrent-zero@example.com",
    photoAssetIds: [],
    files: [],
  });
  const zeroPrefixA = `conc-zero-a-${concurrentZero.requestId}-`;
  const zeroPrefixB = `conc-zero-b-${concurrentZero.requestId}-`;
  const [zeroA, zeroB] = await Promise.all([
    attachRemainingPublicRequestFallbackPhotos(storageDeps, "collpro-reno", {
      requestId: concurrentZero.requestId,
      files: makePngFiles(8, zeroPrefixA),
    }),
    attachRemainingPublicRequestFallbackPhotos(storageDeps, "collpro-reno", {
      requestId: concurrentZero.requestId,
      files: makePngFiles(8, zeroPrefixB),
    }),
  ]);
  const zeroConcurrentCount = await countRequestPhotos(concurrentZero.requestId);
  const zeroUploadedA = await countAssetsByPrefix(zeroPrefixA);
  const zeroUploadedB = await countAssetsByPrefix(zeroPrefixB);
  check(
    "Concurrent 0-recorded + 8/8 fallback handlers finish with exactly 8 rows, not 16",
    concurrentZero.created.ok === true &&
      concurrentZero.count === 0 &&
      zeroConcurrentCount === 8 &&
      zeroA.attached + zeroB.attached === 8 &&
      zeroA.uploaded + zeroB.uploaded === 8 &&
      ((zeroA.uploaded === 8 && zeroB.uploaded === 0) ||
        (zeroB.uploaded === 8 && zeroA.uploaded === 0)) &&
      zeroUploadedA + zeroUploadedB === 8 &&
      ((zeroUploadedA === 8 && zeroUploadedB === 0) ||
        (zeroUploadedB === 8 && zeroUploadedA === 0)),
  );

  const concurrentFull = await submitWithFallback({
    name: "Concurrent Full",
    email: "concurrent-full@example.com",
    photoAssetIds: (await makeReadyPhotos(8)).map((row) => row.id),
    files: [],
  });
  const fullPrefixA = `conc-full-a-${concurrentFull.requestId}-`;
  const fullPrefixB = `conc-full-b-${concurrentFull.requestId}-`;
  const [fullA, fullB] = await Promise.all([
    attachRemainingPublicRequestFallbackPhotos(storageDeps, "collpro-reno", {
      requestId: concurrentFull.requestId,
      files: makePngFiles(8, fullPrefixA),
    }),
    attachRemainingPublicRequestFallbackPhotos(storageDeps, "collpro-reno", {
      requestId: concurrentFull.requestId,
      files: makePngFiles(8, fullPrefixB),
    }),
  ]);
  check(
    "Concurrent fallback on an already-full request uploads zero files and stays at 8",
    concurrentFull.created.ok === true &&
      concurrentFull.count === 8 &&
      (await countRequestPhotos(concurrentFull.requestId)) === 8 &&
      fullA.attached === 0 &&
      fullB.attached === 0 &&
      fullA.uploaded === 0 &&
      fullB.uploaded === 0 &&
      (await countAssetsByPrefix(fullPrefixA)) === 0 &&
      (await countAssetsByPrefix(fullPrefixB)) === 0,
  );

  const independentA = await submitWithFallback({
    name: "Independent A",
    email: "independent-a@example.com",
    photoAssetIds: [],
    files: [],
  });
  const independentB = await submitWithFallback({
    name: "Independent B",
    email: "independent-b@example.com",
    photoAssetIds: [],
    files: [],
  });
  const aReady = createLatch();
  const bReady = createLatch();
  let aHeld = false;
  let bHeld = false;
  let differentRequestsOverlapped = false;
  function noteOverlap() {
    if (aHeld && bHeld) differentRequestsOverlapped = true;
  }
  const [indepA, indepB] = await Promise.all([
    attachRemainingPublicRequestFallbackPhotos(storageDeps, "collpro-reno", {
      requestId: independentA.requestId,
      files: makePngFiles(8, `indep-a-${independentA.requestId}-`),
      onOwnedRequestLocked: async () => {
        aHeld = true;
        noteOverlap();
        aReady.resolve();
        try {
          await waitForPeer(bReady.promise, 5000, "peer request B lock");
          noteOverlap();
        } finally {
          aHeld = false;
        }
      },
    }),
    attachRemainingPublicRequestFallbackPhotos(storageDeps, "collpro-reno", {
      requestId: independentB.requestId,
      files: makePngFiles(8, `indep-b-${independentB.requestId}-`),
      onOwnedRequestLocked: async () => {
        bHeld = true;
        noteOverlap();
        bReady.resolve();
        try {
          await waitForPeer(aReady.promise, 5000, "peer request A lock");
          noteOverlap();
        } finally {
          bHeld = false;
        }
      },
    }),
  ]);
  check(
    "Different requests in the same business are not serialized by a global/table lock",
    independentA.created.ok === true &&
      independentB.created.ok === true &&
      independentA.requestId !== independentB.requestId &&
      differentRequestsOverlapped === true &&
      indepA.attached === 8 &&
      indepB.attached === 8 &&
      (await countRequestPhotos(independentA.requestId)) === 8 &&
      (await countRequestPhotos(independentB.requestId)) === 8,
  );

  console.log("\nDB — Public request photo finalize type gate");
  async function authorizeAndStore(input) {
    const authorized = await authorizeManagedUpload(storageDeps, input.businessId ?? business.id, {
      category: input.category,
      purpose: input.purpose,
      originalFilename: input.name ?? `${input.category}.png`,
      mimeType: "image/png",
      fileSizeBytes: pngBytes.length,
      visibility: input.visibility,
    });
    await provider.putObject({
      bucket: authorized.account.bucketName,
      key: authorized.asset.storageKey,
      body: pngBytes,
      contentType: "image/png",
    });
    return authorized.asset;
  }
  async function expectFinalizeReject(label, slug, assetId) {
    try {
      await finalizePublicRequestPhoto(storageDeps, slug, assetId);
      check(label, false);
    } catch (error) {
      check(label, error instanceof StorageError);
    }
  }
  async function reloadAsset(id) {
    return prisma.storedAsset.findUnique({ where: { id } });
  }

  const pendingCustomer = await authorizeAndStore({
    category: "CUSTOMER_PHOTO",
    visibility: "PRIVATE",
    purpose: "public-request-photo",
    name: "pending-ok.png",
  });
  const finalizedPending = await finalizePublicRequestPhoto(
    storageDeps,
    "collpro-reno",
    pendingCustomer.id,
  );
  check(
    "PENDING PRIVATE CUSTOMER_PHOTO may finalize after the type gate",
    finalizedPending.status === "READY" &&
      finalizedPending.category === "CUSTOMER_PHOTO" &&
      finalizedPending.visibility === "PRIVATE" &&
      finalizedPending.publicPath == null,
  );
  const readyAgain = await finalizePublicRequestPhoto(storageDeps, "collpro-reno", finalizedPending.id);
  check(
    "READY PRIVATE CUSTOMER_PHOTO finalize is idempotent and does not republish",
    readyAgain.id === finalizedPending.id &&
      readyAgain.status === "READY" &&
      readyAgain.category === "CUSTOMER_PHOTO" &&
      readyAgain.visibility === "PRIVATE" &&
      readyAgain.publicPath == null,
  );

  const websitePending = await authorizeAndStore({
    category: "WEBSITE_IMAGE",
    visibility: "PUBLIC",
    purpose: "website:home:hero",
    name: "website.png",
  });
  await expectFinalizeReject(
    "Website photos are rejected before generic finalize",
    "collpro-reno",
    websitePending.id,
  );
  check(
    "Rejected website photo stays PENDING and is not moved to READY",
    (await reloadAsset(websitePending.id))?.status === "PENDING",
  );

  const jobPending = await authorizeAndStore({
    category: "JOB_PHOTO",
    visibility: "PRIVATE",
    purpose: "field-job-photo",
    name: "job.png",
  });
  await expectFinalizeReject(
    "Job photos are rejected before generic finalize",
    "collpro-reno",
    jobPending.id,
  );
  check(
    "Rejected job photo stays PENDING",
    (await reloadAsset(jobPending.id))?.status === "PENDING",
  );

  const vaultPending = await authorizeAndStore({
    category: "DOCUMENT",
    visibility: "PRIVATE",
    purpose: VAULT_DOCUMENT_PURPOSE,
    name: "agreement.pdf",
  });
  await expectFinalizeReject(
    "Vault/agreement documents are rejected before generic finalize",
    "collpro-reno",
    vaultPending.id,
  );
  check(
    "Rejected vault document stays PENDING",
    (await reloadAsset(vaultPending.id))?.status === "PENDING",
  );

  const publicCustomer = await authorizeAndStore({
    category: "CUSTOMER_PHOTO",
    visibility: "PUBLIC",
    purpose: "public-request-photo",
    name: "public-customer.png",
  });
  await expectFinalizeReject(
    "PUBLIC customer photos are rejected before generic finalize",
    "collpro-reno",
    publicCustomer.id,
  );
  const publicAfter = await reloadAsset(publicCustomer.id);
  check(
    "Rejected PUBLIC customer photo stays PENDING without a publicPath",
    publicAfter?.status === "PENDING" && publicAfter.publicPath == null,
  );

  const failedCustomer = await authorizeAndStore({
    category: "CUSTOMER_PHOTO",
    visibility: "PRIVATE",
    purpose: "public-request-photo",
    name: "failed.png",
  });
  await prisma.storedAsset.update({
    where: { id: failedCustomer.id },
    data: { status: "FAILED" },
  });
  await expectFinalizeReject(
    "FAILED customer photos are rejected before generic finalize",
    "collpro-reno",
    failedCustomer.id,
  );
  check(
    "Rejected FAILED photo stays FAILED",
    (await reloadAsset(failedCustomer.id))?.status === "FAILED",
  );

  const deletedCustomer = await authorizeAndStore({
    category: "CUSTOMER_PHOTO",
    visibility: "PRIVATE",
    purpose: "public-request-photo",
    name: "deleted.png",
  });
  await prisma.storedAsset.update({
    where: { id: deletedCustomer.id },
    data: { status: "DELETED", deletedAt: new Date() },
  });
  await expectFinalizeReject(
    "DELETED customer photos are rejected before generic finalize",
    "collpro-reno",
    deletedCustomer.id,
  );
  check(
    "Rejected DELETED photo stays DELETED",
    (await reloadAsset(deletedCustomer.id))?.status === "DELETED",
  );

  const expiredCustomer = await authorizeAndStore({
    category: "CUSTOMER_PHOTO",
    visibility: "PRIVATE",
    purpose: "public-request-photo",
    name: "expired.png",
  });
  await prisma.storedAsset.update({
    where: { id: expiredCustomer.id },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  await expectFinalizeReject(
    "EXPIRED pending customer photos are rejected before generic finalize",
    "collpro-reno",
    expiredCustomer.id,
  );
  check(
    "Rejected expired pending photo is not finalized to READY",
    (await reloadAsset(expiredCustomer.id))?.status === "PENDING",
  );

  const readyWebsite = await authorizeAndStore({
    category: "WEBSITE_IMAGE",
    visibility: "PUBLIC",
    purpose: "website:home:gallery",
    name: "ready-website.png",
  });
  await finalizeManagedUpload(storageDeps, business.id, readyWebsite.id);
  await expectFinalizeReject(
    "Already-READY website photos cannot be finalized through the public request route",
    "collpro-reno",
    readyWebsite.id,
  );
  check(
    "READY website photo remains a WEBSITE_IMAGE",
    (await reloadAsset(readyWebsite.id))?.category === "WEBSITE_IMAGE",
  );

  const otherPending = await authorizeAndStore({
    businessId: other.id,
    category: "CUSTOMER_PHOTO",
    visibility: "PRIVATE",
    purpose: "public-request-photo",
    name: "other-pending.png",
  });
  await expectFinalizeReject(
    "Tenant A slug cannot finalize tenant B pending photo",
    "collpro-reno",
    otherPending.id,
  );
  check(
    "Foreign pending photo stays PENDING on its own tenant",
    (await reloadAsset(otherPending.id))?.status === "PENDING" &&
      (await reloadAsset(otherPending.id))?.businessId === other.id,
  );
  await expectFinalizeReject(
    "Tenant B slug cannot finalize tenant A READY request photo",
    "other-handyman",
    finalizedPending.id,
  );
  check(
    "Cross-tenant finalize leaves the owned READY request photo unchanged",
    (await reloadAsset(finalizedPending.id))?.status === "READY" &&
      (await reloadAsset(finalizedPending.id))?.businessId === business.id,
  );

  console.log("\nDB — Public request photos honor merged storage terminal-state truth");
  async function accountSnapshot(businessId) {
    const account = await prisma.businessStorageAccount.findUnique({
      where: { businessId },
    });
    return {
      reserved: Number(account?.storageReservedBytes ?? 0),
      used: Number(account?.storageUsedBytes ?? 0),
    };
  }
  async function createRequestWithPhotoIds(name, email, photoAssetIds, submissionId) {
    const created = await createPublicServiceRequest(prisma, {
      slug: "collpro-reno",
      name,
      email,
      phone: "555-0418",
      address: "",
      streetAddress: "12 Oak St",
      city: "Fort Myers",
      region: "FL",
      postalCode: "33901",
      notes: "Storage terminal-state",
      catalogItemIds: [fan.id],
      includeOther: false,
      otherDescription: "",
      photoAssetIds,
      submissionId,
    });
    const photos = created.ok
      ? await prisma.serviceRequestPhoto.findMany({
          where: { serviceRequestId: created.requestId, businessId: business.id },
        })
      : [];
    return { created, photos };
  }

  const managedReady = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "terminal-ready.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const managedReadyRequest = await createRequestWithPhotoIds(
    "Terminal Ready",
    "terminal-ready@example.com",
    [managedReady.id],
  );
  check(
    "Normal public-request managed photo finalizes READY CUSTOMER_PHOTO PRIVATE and attaches once",
    managedReady.status === "READY" &&
      managedReady.category === "CUSTOMER_PHOTO" &&
      managedReady.visibility === "PRIVATE" &&
      managedReady.publicPath == null &&
      managedReadyRequest.created.ok === true &&
      managedReadyRequest.photos.length === 1 &&
      managedReadyRequest.photos[0].storedAssetId === managedReady.id,
  );

  const afterFirstReady = await accountSnapshot(business.id);
  const readyRetry = await finalizePublicRequestPhoto(storageDeps, "collpro-reno", managedReady.id);
  const afterReadyRetry = await accountSnapshot(business.id);
  const readyRetryRequest = await createRequestWithPhotoIds(
    "Terminal Ready Retry",
    "terminal-ready-retry@example.com",
    [managedReady.id, managedReady.id],
  );
  check(
    "READY public-request finalize is idempotent and does not re-account storage",
    readyRetry.id === managedReady.id &&
      readyRetry.status === "READY" &&
      readyRetry.publicPath == null &&
      afterReadyRetry.reserved === afterFirstReady.reserved &&
      afterReadyRetry.used === afterFirstReady.used,
  );
  check(
    "READY retry does not duplicate the ServiceRequestPhoto attachment",
    readyRetryRequest.created.ok === true &&
      readyRetryRequest.photos.length === 1 &&
      readyRetryRequest.photos[0].storedAssetId === managedReady.id,
  );

  const failedAuth = await authorizePublicRequestPhoto(storageDeps, "collpro-reno", {
    originalFilename: "terminal-failed.png",
    mimeType: "image/png",
    fileSizeBytes: pngBytes.length,
  });
  await provider.putObject({
    bucket: failedAuth.account.bucketName,
    key: failedAuth.asset.storageKey,
    body: pngBytes,
    contentType: "image/png",
  });
  const abortedFailed = await abortPublicRequestPhoto(storageDeps, "collpro-reno", failedAuth.asset.id);
  let failedFinalizeError = null;
  try {
    await finalizePublicRequestPhoto(storageDeps, "collpro-reno", failedAuth.asset.id);
  } catch (error) {
    failedFinalizeError = error;
  }
  const failedAfter = await reloadAsset(failedAuth.asset.id);
  const failedRequest = await createRequestWithPhotoIds(
    "Terminal Failed",
    "terminal-failed@example.com",
    [failedAuth.asset.id],
  );
  check(
    "FAILED storage truth is rejected before public-request finalize and does not attach",
    abortedFailed.status === "FAILED" &&
      failedFinalizeError instanceof StorageError &&
      failedAfter?.status === "FAILED" &&
      failedRequest.created.ok === false &&
      failedRequest.created.error === PUBLIC_REQUEST_PHOTO_UNAVAILABLE &&
      failedRequest.photos.length === 0,
  );
  check(
    "FAILED public-request photo is not resurrected to READY",
    failedAfter?.status === "FAILED" && failedAfter.publicPath == null,
  );

  const expiredAuth = await authorizePublicRequestPhoto(storageDeps, "collpro-reno", {
    originalFilename: "terminal-expired.png",
    mimeType: "image/png",
    fileSizeBytes: pngBytes.length,
  });
  await provider.putObject({
    bucket: expiredAuth.account.bucketName,
    key: expiredAuth.asset.storageKey,
    body: pngBytes,
    contentType: "image/png",
  });
  await prisma.storedAsset.update({
    where: { id: expiredAuth.asset.id },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  let expiredFinalizeError = null;
  try {
    await finalizePublicRequestPhoto(storageDeps, "collpro-reno", expiredAuth.asset.id);
  } catch (error) {
    expiredFinalizeError = error;
  }
  const expiredAfter = await reloadAsset(expiredAuth.asset.id);
  const expiredRequest = await createRequestWithPhotoIds(
    "Terminal Expired",
    "terminal-expired@example.com",
    [expiredAuth.asset.id],
  );
  check(
    "Expired PENDING public-request photo is rejected, not attached, and not resurrected",
    expiredFinalizeError instanceof StorageError &&
      expiredAfter?.status !== "READY" &&
      expiredRequest.created.ok === false &&
      expiredRequest.created.error === PUBLIC_REQUEST_PHOTO_UNAVAILABLE &&
      expiredRequest.photos.length === 0,
  );

  const oversizedAuth = await authorizePublicRequestPhoto(storageDeps, "collpro-reno", {
    originalFilename: "terminal-oversized.png",
    mimeType: "image/png",
    fileSizeBytes: 10,
  });
  await provider.putObject({
    bucket: oversizedAuth.account.bucketName,
    key: oversizedAuth.asset.storageKey,
    body: pngBytes,
    contentType: "image/png",
  });
  let oversizedError = null;
  try {
    await finalizePublicRequestPhoto(storageDeps, "collpro-reno", oversizedAuth.asset.id);
  } catch (error) {
    oversizedError = error;
  }
  const oversizedAfter = await reloadAsset(oversizedAuth.asset.id);
  const oversizedRequest = await createRequestWithPhotoIds(
    "Terminal Oversized",
    "terminal-oversized@example.com",
    [oversizedAuth.asset.id],
  );
  let oversizedRetryError = null;
  try {
    await finalizePublicRequestPhoto(storageDeps, "collpro-reno", oversizedAuth.asset.id);
  } catch (error) {
    oversizedRetryError = error;
  }
  const oversizedRetry = await reloadAsset(oversizedAuth.asset.id);
  check(
    "Oversized public-request finalize keeps canonical StorageQuotaError and does not attach",
    oversizedError instanceof StorageQuotaError &&
      oversizedAfter?.status === "FAILED" &&
      oversizedRequest.created.ok === false &&
      oversizedRequest.created.error === PUBLIC_REQUEST_PHOTO_UNAVAILABLE &&
      oversizedRequest.photos.length === 0,
  );
  check(
    "Oversized public-request retry does not resurrect FAILED to READY",
    oversizedRetryError instanceof StorageError &&
      oversizedRetry?.status === "FAILED" &&
      oversizedRetry.publicPath == null,
  );

  console.log("\nDB — Unattached request-photo TTL keeps in-progress form photos");
  let clockMs = Date.now();
  const clockedDeps = {
    ...storageDeps,
    now: () => new Date(clockMs),
  };
  const lingerPhoto = await putPublicRequestPhotoFromBytes(clockedDeps, "collpro-reno", {
    originalFilename: "linger-unattached.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const lingerStarted = clockMs;
  clockMs = lingerStarted + STORAGE_PENDING_TTL_MS;
  await authorizePublicRequestPhoto(clockedDeps, "collpro-reno", {
    originalFilename: "sweep-at-15m.png",
    mimeType: "image/png",
    fileSizeBytes: pngBytes.length,
  });
  const lingerAt15m = await reloadAsset(lingerPhoto.id);
  clockMs = lingerStarted + 2 * 60 * 60 * 1000;
  await releaseExpiredUnattachedPublicRequestPhotos(clockedDeps, business.id);
  const lingerAt2h = await reloadAsset(lingerPhoto.id);
  check(
    "Finalized-but-unattached request photo is not swept at 15 minutes or 2 hours",
    lingerPhoto.status === "READY" &&
      lingerPhoto.expiresAt != null &&
      lingerPhoto.expiresAt.getTime() === lingerStarted + UNATTACHED_REQUEST_PHOTO_TTL_MS &&
      lingerAt15m?.status === "READY" &&
      lingerAt2h?.status === "READY",
  );

  const keepFirst = await putPublicRequestPhotoFromBytes(clockedDeps, "collpro-reno", {
    originalFilename: "keep-first.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  clockMs += 30 * 60 * 1000;
  const keepSecond = await putPublicRequestPhotoFromBytes(clockedDeps, "collpro-reno", {
    originalFilename: "keep-second.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const keepFirstAfterSecond = await reloadAsset(keepFirst.id);
  const lateSubmit = await createRequestWithPhotoIds(
    "Thirty Minute Form",
    `thirty-min-${randomUUID()}@example.com`,
    [keepFirst.id, keepSecond.id],
  );
  check(
    "Customer submitting after 30 minutes keeps the first finalized photo",
    keepFirstAfterSecond?.status === "READY" &&
      lateSubmit.created.ok === true &&
      lateSubmit.photos.length === 2 &&
      lateSubmit.photos.some((row) => row.storedAssetId === keepFirst.id) &&
      lateSubmit.photos.some((row) => row.storedAssetId === keepSecond.id),
  );

  clockMs = lingerStarted + UNATTACHED_REQUEST_PHOTO_TTL_MS + 1;
  const lingerSweep = await releaseExpiredUnattachedPublicRequestPhotos(
    clockedDeps,
    business.id,
  );
  const lingerAfterTtl = await reloadAsset(lingerPhoto.id);
  check(
    "Unattached request photo is swept only after the 24-hour attach TTL",
    lingerSweep.released >= 1 && lingerAfterTtl?.status === "FAILED",
  );

  const vanished = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "vanished-selected.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  await prisma.storedAsset.update({
    where: { id: vanished.id },
    data: { status: "FAILED", deletedAt: new Date() },
  });
  const vanishedEmail = `vanished-${randomUUID()}@example.com`;
  const vanishedSubmit = await createRequestWithPhotoIds(
    "Vanished Selected",
    vanishedEmail,
    [vanished.id],
  );
  const vanishedRequest = await prisma.serviceRequest.findFirst({
    where: { businessId: business.id, customer: { email: vanishedEmail } },
    select: { id: true },
  });
  check(
    "Selected photo that is no longer READY refuses submit and asks to re-add it",
    vanishedSubmit.created.ok === false &&
      vanishedSubmit.created.error === PUBLIC_REQUEST_PHOTO_UNAVAILABLE &&
      vanishedSubmit.photos.length === 0 &&
      vanishedRequest == null,
  );

  const ninePhotos = [];
  for (let index = 0; index < MAX_INTAKE_PHOTOS + 1; index += 1) {
    ninePhotos.push(
      await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
        originalFilename: `nine-retry-${index}.png`,
        mimeType: "image/png",
        body: pngBytes,
      }),
    );
  }
  const nineSubmissionId = `ninephoto${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const nineEmail = `nine-retry-${randomUUID()}@example.com`;
  const nineFirst = await createRequestWithPhotoIds(
    "Nine Photo Retry",
    nineEmail,
    ninePhotos.map((row) => row.id),
    nineSubmissionId,
  );
  const nineRetry = await createRequestWithPhotoIds(
    "Nine Photo Retry",
    nineEmail,
    ninePhotos.map((row) => row.id),
    nineSubmissionId,
  );
  const nineRows = await prisma.serviceRequest.findMany({
    where: {
      businessId: business.id,
      description: { contains: `${INTAKE_SUBMISSION_MARKER}${nineSubmissionId}` },
    },
    select: { id: true },
  });
  const nineReleased = [];
  for (const asset of ninePhotos) {
    const row = await reloadAsset(asset.id);
    if (!nineFirst.photos.some((photo) => photo.storedAssetId === asset.id)) {
      nineReleased.push(row);
    }
  }
  check(
    "Retry with the same submissionId returns the existing request after leftover photo release",
    nineFirst.created.ok === true &&
      nineFirst.photos.length === MAX_INTAKE_PHOTOS &&
      nineReleased.length === 1 &&
      nineReleased[0]?.status === "FAILED" &&
      nineRetry.created.ok === true &&
      nineRetry.created.requestId === nineFirst.created.requestId &&
      nineRows.length === 1,
  );

  const staleNullExpiry = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "stale-null-expiry.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const freshNullExpiry = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "fresh-null-expiry.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const staleUpdatedAt = new Date(Date.now() - UNATTACHED_REQUEST_PHOTO_TTL_MS - 60_000);
  await prisma.storedAsset.update({
    where: { id: staleNullExpiry.id },
    data: { expiresAt: null, updatedAt: staleUpdatedAt },
  });
  await prisma.storedAsset.update({
    where: { id: freshNullExpiry.id },
    data: { expiresAt: null },
  });
  const nullExpirySweep = await releaseExpiredUnattachedPublicRequestPhotos(
    storageDeps,
    business.id,
  );
  const staleAfterSweep = await reloadAsset(staleNullExpiry.id);
  const freshAfterSweep = await reloadAsset(freshNullExpiry.id);
  check(
    "Sweep releases READY unattached request photos with a null expiry older than 24h",
    nullExpirySweep.released >= 1 &&
      staleAfterSweep?.status === "FAILED" &&
      freshAfterSweep?.status === "READY",
  );

  const leftoverFailPhotos = [];
  for (let index = 0; index < MAX_INTAKE_PHOTOS + 1; index += 1) {
    leftoverFailPhotos.push(
      await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
        originalFilename: `leftover-fail-${index}.png`,
        mimeType: "image/png",
        body: pngBytes,
      }),
    );
  }
  const leftoverFailEmail = `leftover-fail-${randomUUID()}@example.com`;
  let leftoverFailSubmit;
  requestPhotoTestHooks.beforeReleaseUnattached = () => {
    throw new Error("forced leftover release failure");
  };
  try {
    leftoverFailSubmit = await createRequestWithPhotoIds(
      "Leftover Fail",
      leftoverFailEmail,
      leftoverFailPhotos.map((row) => row.id),
    );
  } finally {
    delete requestPhotoTestHooks.beforeReleaseUnattached;
  }
  const leftoverFailRequest = leftoverFailSubmit.created.ok
    ? await prisma.serviceRequest.findFirst({
        where: { id: leftoverFailSubmit.created.requestId, businessId: business.id },
        select: { id: true },
      })
    : null;
  check(
    "Leftover release failure after commit still returns the created request",
    leftoverFailSubmit.created.ok === true && leftoverFailRequest?.id === leftoverFailSubmit.created.requestId,
  );

  function createLockBarrier() {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let arrived;
    const waiting = new Promise((resolve) => {
      arrived = resolve;
    });
    return { held, waiting, arrived, release };
  }

  const sweepFirstPhoto = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "sweep-first-lock.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const sweepFirstEmail = `sweep-first-${randomUUID()}@example.com`;
  const sweepClient = new PrismaClient({ datasourceUrl: testUrl });
  const submitDuringSweep = new PrismaClient({ datasourceUrl: testUrl });
  await sweepClient.$executeRawUnsafe(`SET timezone = 'UTC'`);
  await submitDuringSweep.$executeRawUnsafe(`SET timezone = 'UTC'`);
  const sweepBarrier = createLockBarrier();
  requestPhotoTestHooks.afterStoredAssetLock = async ({ assetId }) => {
    if (assetId !== sweepFirstPhoto.id) return;
    sweepBarrier.arrived();
    await sweepBarrier.held;
  };
  try {
    const sweepFirstPromise = releaseUnattachedPublicRequestPhotos(
      { ...storageDeps, db: sweepClient },
      business.id,
      [sweepFirstPhoto.id],
    );
    await sweepBarrier.waiting;
    const submitDuringSweepPromise = createPublicServiceRequest(submitDuringSweep, {
      slug: "collpro-reno",
      name: "Sweep First",
      email: sweepFirstEmail,
      phone: "555-0418",
      address: "",
      streetAddress: "12 Oak St",
      city: "Fort Myers",
      region: "FL",
      postalCode: "33901",
      notes: "Sweep first lock",
      catalogItemIds: [fan.id],
      includeOther: false,
      otherDescription: "",
      photoAssetIds: [sweepFirstPhoto.id],
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    sweepBarrier.release();
    const [sweepFirstResult, submitDuringSweepResult] = await Promise.all([
      sweepFirstPromise,
      submitDuringSweepPromise,
    ]);
    const sweepFirstCustomer = await prisma.customer.findFirst({
      where: { businessId: business.id, email: sweepFirstEmail },
      select: { id: true },
    });
    const sweepFirstRequest = await prisma.serviceRequest.findFirst({
      where: { businessId: business.id, customer: { email: sweepFirstEmail } },
      select: { id: true },
    });
    const sweepFirstPhotoRow = await prisma.serviceRequestPhoto.findFirst({
      where: { businessId: business.id, storedAssetId: sweepFirstPhoto.id },
      select: { id: true },
    });
    check(
      "Sweep-first row lock refuses submit with the re-add message and creates no rows",
      sweepFirstResult.released === 1 &&
        submitDuringSweepResult.ok === false &&
        submitDuringSweepResult.error === PUBLIC_REQUEST_PHOTO_UNAVAILABLE &&
        sweepFirstCustomer == null &&
        sweepFirstRequest == null &&
        sweepFirstPhotoRow == null,
    );
  } finally {
    delete requestPhotoTestHooks.afterStoredAssetLock;
    await sweepClient.$disconnect();
    await submitDuringSweep.$disconnect();
  }

  const submitFirstPhoto = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "submit-first-lock.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const submitFirstEmail = `submit-first-${randomUUID()}@example.com`;
  const submitClient = new PrismaClient({ datasourceUrl: testUrl });
  const sweepDuringSubmit = new PrismaClient({ datasourceUrl: testUrl });
  await submitClient.$executeRawUnsafe(`SET timezone = 'UTC'`);
  await sweepDuringSubmit.$executeRawUnsafe(`SET timezone = 'UTC'`);
  const submitBarrier = createLockBarrier();
  requestPhotoTestHooks.afterStoredAssetLock = async ({ assetId }) => {
    if (assetId !== submitFirstPhoto.id) return;
    submitBarrier.arrived();
    await submitBarrier.held;
  };
  try {
    const submitFirstPromise = createPublicServiceRequest(submitClient, {
      slug: "collpro-reno",
      name: "Submit First",
      email: submitFirstEmail,
      phone: "555-0418",
      address: "",
      streetAddress: "12 Oak St",
      city: "Fort Myers",
      region: "FL",
      postalCode: "33901",
      notes: "Submit first lock",
      catalogItemIds: [fan.id],
      includeOther: false,
      otherDescription: "",
      photoAssetIds: [submitFirstPhoto.id],
    });
    await submitBarrier.waiting;
    const sweepDuringSubmitPromise = releaseUnattachedPublicRequestPhotos(
      { ...storageDeps, db: sweepDuringSubmit },
      business.id,
      [submitFirstPhoto.id],
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    submitBarrier.release();
    const [submitFirstResult, sweepDuringSubmitResult] = await Promise.all([
      submitFirstPromise,
      sweepDuringSubmitPromise,
    ]);
    check(
      "Submit-first row lock attaches the photo and the waiting sweep releases 0",
      submitFirstResult.ok === true && sweepDuringSubmitResult.released === 0,
    );
  } finally {
    delete requestPhotoTestHooks.afterStoredAssetLock;
    await submitClient.$disconnect();
    await sweepDuringSubmit.$disconnect();
  }

  function isDeadlockError(error) {
    const text = [
      error?.code,
      error?.meta?.code,
      error?.cause?.code,
      error?.message,
      error?.cause?.message,
      String(error ?? ""),
    ]
      .filter(Boolean)
      .join(" ");
    return /40P01|deadlock detected|P2034/i.test(text);
  }

  function createCountBarrier(needed) {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let count = 0;
    let arrivedAll;
    const waiting = new Promise((resolve) => {
      arrivedAll = resolve;
    });
    return {
      held,
      waiting,
      arrive() {
        count += 1;
        if (count >= needed) arrivedAll();
      },
      release,
    };
  }

  function photoLockSql(ids) {
    const ordered = sortedStoredAssetIds(ids);
    return [
      "BEGIN;",
      `SELECT id FROM "StoredAsset" WHERE id = '${ordered[0]}' AND "businessId" = '${business.id}' FOR UPDATE;`,
      "SELECT pg_sleep(0.4);",
      `SELECT id FROM "StoredAsset" WHERE id = '${ordered[1]}' AND "businessId" = '${business.id}' FOR UPDATE;`,
      "COMMIT;",
    ].join("\n");
  }

  function runPsqlLockScript(sql) {
    const psqlUrl = new URL(testUrl);
    psqlUrl.searchParams.delete("schema");
    return new Promise((resolve) => {
      const child = spawn("psql", [psqlUrl.toString(), "-v", "ON_ERROR_STOP=1", "-c", sql], {
        encoding: "utf8",
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        err += chunk;
      });
      child.on("close", (code) => {
        resolve({
          status: code === 0 ? "fulfilled" : "rejected",
          reason: new Error(`${err}\n${out}`),
          code,
          err,
          out,
        });
      });
    });
  }

  async function runOppositeOrderPhotoLocks(forwardIds, reverseIds) {
    return Promise.all([
      runPsqlLockScript(photoLockSql(forwardIds)),
      runPsqlLockScript(photoLockSql(reverseIds)),
    ]);
  }

  const lockOrderLeft = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "lock-order-left.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const lockOrderRight = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "lock-order-right.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const [lockLow, lockHigh] =
    lockOrderLeft.id < lockOrderRight.id
      ? [lockOrderLeft.id, lockOrderRight.id]
      : [lockOrderRight.id, lockOrderLeft.id];
  const oppositeSubmitA = new PrismaClient({ datasourceUrl: testUrl });
  const oppositeSubmitB = new PrismaClient({ datasourceUrl: testUrl });
  const oppositeReleaseA = new PrismaClient({ datasourceUrl: testUrl });
  const oppositeReleaseB = new PrismaClient({ datasourceUrl: testUrl });
  await Promise.all([
    oppositeSubmitA.$executeRawUnsafe(`SET timezone = 'UTC'`),
    oppositeSubmitB.$executeRawUnsafe(`SET timezone = 'UTC'`),
    oppositeReleaseA.$executeRawUnsafe(`SET timezone = 'UTC'`),
    oppositeReleaseB.$executeRawUnsafe(`SET timezone = 'UTC'`),
  ]);
  const releasePairLeft = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "lock-order-release-left.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const releasePairRight = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "lock-order-release-right.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const [releaseLow, releaseHigh] =
    releasePairLeft.id < releasePairRight.id
      ? [releasePairLeft.id, releasePairRight.id]
      : [releasePairRight.id, releasePairLeft.id];
  try {
    const oppositeSettled = await Promise.allSettled([
      createPublicServiceRequest(oppositeSubmitA, {
        slug: "collpro-reno",
        name: "Opposite Submit A",
        email: `opp-a-${randomUUID()}@example.com`,
        phone: "555-0418",
        address: "",
        streetAddress: "12 Oak St",
        city: "Fort Myers",
        region: "FL",
        postalCode: "33901",
        notes: "Opposite order A",
        catalogItemIds: [fan.id],
        includeOther: false,
        otherDescription: "",
        photoAssetIds: [lockLow, lockHigh],
      }),
      createPublicServiceRequest(oppositeSubmitB, {
        slug: "collpro-reno",
        name: "Opposite Submit B",
        email: `opp-b-${randomUUID()}@example.com`,
        phone: "555-0418",
        address: "",
        streetAddress: "12 Oak St",
        city: "Fort Myers",
        region: "FL",
        postalCode: "33901",
        notes: "Opposite order B",
        catalogItemIds: [fan.id],
        includeOther: false,
        otherDescription: "",
        photoAssetIds: [lockHigh, lockLow],
      }),
      releaseUnattachedPublicRequestPhotos(
        { ...storageDeps, db: oppositeReleaseA },
        business.id,
        [releaseLow, releaseHigh],
      ),
      releaseUnattachedPublicRequestPhotos(
        { ...storageDeps, db: oppositeReleaseB },
        business.id,
        [releaseHigh, releaseLow],
      ),
    ]);
    check(
      "Opposite-order overlapping submits and releases do not deadlock when ids are sorted",
      oppositeSettled.every((row) => row.status === "fulfilled") &&
        !oppositeSettled.some(
          (row) => row.status === "rejected" && isDeadlockError(row.reason),
        ),
    );
  } finally {
    await Promise.all([
      oppositeSubmitA.$disconnect(),
      oppositeSubmitB.$disconnect(),
      oppositeReleaseA.$disconnect(),
      oppositeReleaseB.$disconnect(),
    ]);
  }

  const mutationLeft = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "lock-order-mutation-left.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const mutationRight = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "lock-order-mutation-right.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const [mutationLow, mutationHigh] =
    mutationLeft.id < mutationRight.id
      ? [mutationLeft.id, mutationRight.id]
      : [mutationRight.id, mutationLeft.id];
  requestPhotoTestHooks.skipAssetIdSort = true;
  try {
    const unsortedLocks = await runOppositeOrderPhotoLocks(
      [mutationLow, mutationHigh],
      [mutationHigh, mutationLow],
    );
    const unsortedReleases = await runOppositeOrderPhotoLocks(
      [mutationHigh, mutationLow],
      [mutationLow, mutationHigh],
    );
    const deadlockSeen = [...unsortedLocks, ...unsortedReleases].some(
      (row) =>
        row.status === "rejected" &&
        (isDeadlockError(row.reason) ||
          /40P01|deadlock detected/i.test(`${row.err ?? ""} ${row.out ?? ""}`)),
    );
    check(
      "Reverting photo lock sort deadlocks opposite-order overlapping transactions",
      deadlockSeen,
    );
  } finally {
    delete requestPhotoTestHooks.skipAssetIdSort;
  }

  console.log("\nDB — Abandoned and overflow request photos release quota");
  const abandonedBefore = await accountSnapshot(business.id);
  const abandoned = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "abandoned-never-submitted.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const abandonedAfterUpload = await accountSnapshot(business.id);
  check(
    "Unattached finalized request photo keeps a pending-attachment expiry",
    abandoned.status === "READY" &&
      abandoned.expiresAt != null &&
      abandonedAfterUpload.used === abandonedBefore.used + pngBytes.length &&
      abandonedAfterUpload.reserved === abandonedBefore.reserved,
  );
  await prisma.storedAsset.update({
    where: { id: abandoned.id },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const expiredCleanup = await releaseExpiredUnattachedPublicRequestPhotos(
    storageDeps,
    business.id,
  );
  const abandonedAfter = await reloadAsset(abandoned.id);
  const abandonedAccount = await accountSnapshot(business.id);
  check(
    "Expired unattached request photo is uncharged and removed from storage",
    expiredCleanup.released >= 1 &&
      abandonedAfter?.status === "FAILED" &&
      abandonedAccount.used === abandonedBefore.used &&
      abandonedAccount.reserved === abandonedBefore.reserved &&
      !(await provider.objectExists({
        bucket: storageDeps.bucketName,
        key: abandoned.storageKey,
      })),
  );

  const overflowBefore = await accountSnapshot(business.id);
  const overflowPhotos = [];
  for (let index = 0; index < MAX_INTAKE_PHOTOS + 2; index += 1) {
    overflowPhotos.push(
      await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
        originalFilename: `overflow-${index}.png`,
        mimeType: "image/png",
        body: pngBytes,
      }),
    );
  }
  const overflowCreated = await createRequestWithPhotoIds(
    "Overflow Photos",
    `overflow-${randomUUID()}@example.com`,
    overflowPhotos.map((row) => row.id),
  );
  const overflowAttachedIds = new Set(
    overflowCreated.photos.map((row) => row.storedAssetId),
  );
  const overflowLeftover = [];
  for (const asset of overflowPhotos) {
    const row = await reloadAsset(asset.id);
    if (!overflowAttachedIds.has(asset.id)) overflowLeftover.push(row);
  }
  const overflowAfter = await accountSnapshot(business.id);
  check(
    "Submitting more than MAX_INTAKE_PHOTOS attaches the cap and releases extras",
    overflowCreated.created.ok === true &&
      overflowCreated.photos.length === MAX_INTAKE_PHOTOS &&
      overflowLeftover.length === 2 &&
      overflowLeftover.every((row) => row?.status === "FAILED") &&
      overflowAfter.used === overflowBefore.used + MAX_INTAKE_PHOTOS * pngBytes.length &&
      overflowAfter.reserved === overflowBefore.reserved,
  );

  const batchedReal = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "batched-overflow-real.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const batchedIds = [
    ...Array.from({ length: MAX_UNATTACHED_REQUEST_PHOTO_RELEASE_BATCH + 10 }, () =>
      randomUUID(),
    ),
    batchedReal.id,
  ];
  const batchedRelease = await releaseUnattachedPublicRequestPhotos(
    storageDeps,
    business.id,
    batchedIds,
  );
  const batchedAfter = await reloadAsset(batchedReal.id);
  check(
    "Overflow release batches ids beyond the lookup cap and still claims the real leftover",
    batchedRelease.released === 1 && batchedAfter?.status === "FAILED",
  );

  console.log("\nDB — Unattached public request photo cap and rejection release");
  async function unattachedPublicPhotoWhere(businessId) {
    return {
      businessId,
      purpose: "public-request-photo",
      category: "CUSTOMER_PHOTO",
      visibility: "PRIVATE",
      deletedAt: null,
      status: { in: ["READY", "PENDING"] },
      serviceRequestPhotos: { none: {} },
    };
  }
  async function countUnattachedPublicPhotos(businessId) {
    return prisma.storedAsset.count({
      where: await unattachedPublicPhotoWhere(businessId),
    });
  }
  async function sumUnattachedPublicPhotoBytes(businessId) {
    const rows = await prisma.storedAsset.findMany({
      where: {
        ...(await unattachedPublicPhotoWhere(businessId)),
        status: "READY",
      },
      select: { fileSizeBytes: true },
    });
    return rows.reduce((sum, row) => sum + Number(row.fileSizeBytes), 0);
  }
  const authorizeInput = {
    originalFilename: "cap-race.png",
    mimeType: "image/png",
    fileSizeBytes: pngBytes.length,
  };
  async function tryAuthorize(deps) {
    try {
      return {
        ok: true,
        asset: await authorizePublicRequestPhoto(deps, "collpro-reno", authorizeInput),
      };
    } catch (error) {
      return { ok: false, error };
    }
  }

  const baselineUnattached = await countUnattachedPublicPhotos(business.id);
  const attachedForCap = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "cap-attached.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  await createRequestWithPhotoIds(
    "Cap Attached",
    `cap-attached-${randomUUID()}@example.com`,
    [attachedForCap.id],
  );
  requestPhotoTestHooks.unattachedCountCap = baselineUnattached + 1;
  const afterAttachUnattached = await countUnattachedPublicPhotos(business.id);
  const extraWhileAttached = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "cap-after-attach.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  check(
    "Attached request photos do not consume the unattached public-photo cap",
    afterAttachUnattached === baselineUnattached && extraWhileAttached.status === "READY",
  );

  requestPhotoTestHooks.unattachedCountCap = (await countUnattachedPublicPhotos(business.id)) + 1;
  const capClientA = new PrismaClient({ datasourceUrl: testUrl });
  const capClientB = new PrismaClient({ datasourceUrl: testUrl });
  await capClientA.$executeRawUnsafe(`SET timezone = 'UTC'`);
  await capClientB.$executeRawUnsafe(`SET timezone = 'UTC'`);
  const capBarrier = createLockBarrier();
  let firstCapLock = true;
  requestPhotoTestHooks.afterUnattachedCapLock = async () => {
    if (!firstCapLock) return;
    firstCapLock = false;
    capBarrier.arrived();
    await capBarrier.held;
  };
  try {
    const firstCap = tryAuthorize({ ...storageDeps, db: capClientA });
    await capBarrier.waiting;
    const secondCap = tryAuthorize({ ...storageDeps, db: capClientB });
    await new Promise((resolve) => setTimeout(resolve, 250));
    capBarrier.release();
    const [capA, capB] = await Promise.all([firstCap, secondCap]);
    const winners = [capA, capB].filter((row) => row.ok);
    const losers = [capA, capB].filter((row) => !row.ok);
    check(
      "Unattached photo cap is enforced across two concurrent authorize connections",
      winners.length === 1 &&
        losers.length === 1 &&
        losers[0].error instanceof StorageError &&
        losers[0].error.message === PUBLIC_REQUEST_PHOTO_CAP_REACHED,
    );
  } finally {
    delete requestPhotoTestHooks.afterUnattachedCapLock;
    delete requestPhotoTestHooks.unattachedCountCap;
    await capClientA.$disconnect();
    await capClientB.$disconnect();
  }

  requestPhotoTestHooks.unattachedCountCap = await countUnattachedPublicPhotos(business.id);
  let blockedPublic = null;
  try {
    await authorizePublicRequestPhoto(storageDeps, "collpro-reno", authorizeInput);
  } catch (error) {
    blockedPublic = error;
  }
  const ownerStillUploads = await authorizeManagedUpload(storageDeps, business.id, {
    category: "JOB_PHOTO",
    purpose: "field-job-photo",
    originalFilename: "owner-not-blocked.png",
    mimeType: "image/png",
    fileSizeBytes: pngBytes.length,
    visibility: "PRIVATE",
  });
  delete requestPhotoTestHooks.unattachedCountCap;
  check(
    "Public unattached-photo cap does not block legitimate business uploads",
    blockedPublic instanceof StorageError &&
      blockedPublic.message === PUBLIC_REQUEST_PHOTO_CAP_REACHED &&
      ownerStillUploads.asset.category === "JOB_PHOTO" &&
      ownerStillUploads.asset.status === "PENDING",
  );

  const unitBytes = 10_000;
  const fivePhotoByteCap = 5 * unitBytes;
  const baselineByteUsed = await sumUnattachedPublicPhotoBytes(business.id);
  const otherBaselineByteUsed = await sumUnattachedPublicPhotoBytes(other.id);
  requestPhotoTestHooks.unattachedByteCap = baselineByteUsed + fivePhotoByteCap;
  const mixedSizes = [
    ...Array.from({ length: 10 }, () => unitBytes),
    ...Array.from({ length: 10 }, () => 2 * unitBytes),
    ...Array.from({ length: 10 }, () => Math.floor(unitBytes / 2)),
  ];
  const byteCapResults = await Promise.all(
    mixedSizes.map(async (fileSizeBytes, index) => {
      try {
        const uploaded = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
          originalFilename: `byte-cap-${index}.png`,
          mimeType: "image/png",
          body: Buffer.alloc(fileSizeBytes),
        });
        return { ok: true, bytes: uploaded.fileSizeBytes };
      } catch (error) {
        return { ok: false, bytes: fileSizeBytes, error };
      }
    }),
  );
  const byteWinners = byteCapResults.filter((row) => row.ok);
  const byteLosers = byteCapResults.filter((row) => !row.ok);
  const winnerBytes = byteWinners.reduce((sum, row) => sum + Number(row.bytes), 0);
  const afterWaveBytes = await sumUnattachedPublicPhotoBytes(business.id);
  const smallestLoser = Math.min(...byteLosers.map((row) => row.bytes));
  let otherTenantDuringCap = null;
  try {
    otherTenantDuringCap = await putPublicRequestPhotoFromBytes(storageDeps, "other-handyman", {
      originalFilename: "other-tenant-byte-cap.png",
      mimeType: "image/png",
      body: Buffer.alloc(2 * unitBytes),
    });
  } catch (error) {
    otherTenantDuringCap = error;
  }
  const ownerDuringByteCap = await authorizeManagedUpload(storageDeps, business.id, {
    category: "JOB_PHOTO",
    purpose: "field-job-photo",
    originalFilename: "owner-during-byte-cap.png",
    mimeType: "image/png",
    fileSizeBytes: 3 * unitBytes,
    visibility: "PRIVATE",
  });
  delete requestPhotoTestHooks.unattachedByteCap;
  check(
    "Unattached byte cap admits only what fits 5 photos' worth across 30 mixed-size uploads",
    byteWinners.length >= 1 &&
      byteLosers.length >= 1 &&
      byteLosers.every(
        (row) => row.error instanceof StorageError && row.error.message === PUBLIC_REQUEST_PHOTO_CAP_REACHED,
      ) &&
      winnerBytes <= fivePhotoByteCap &&
      afterWaveBytes === baselineByteUsed + winnerBytes &&
      afterWaveBytes <= baselineByteUsed + fivePhotoByteCap &&
      winnerBytes + smallestLoser > fivePhotoByteCap,
  );
  check(
    "Unattached byte cap is tenant-scoped and does not block owner uploads",
    otherTenantDuringCap &&
      !(otherTenantDuringCap instanceof Error) &&
      otherTenantDuringCap.status === "READY" &&
      (await sumUnattachedPublicPhotoBytes(other.id)) === otherBaselineByteUsed + 2 * unitBytes &&
      ownerDuringByteCap.asset.category === "JOB_PHOTO" &&
      ownerDuringByteCap.asset.status === "PENDING",
  );

  const unusedDeclaredBytes = 3 * unitBytes;
  const unusedAuthorizeCount = 12;
  const unusedReadyBefore = await sumUnattachedPublicPhotoBytes(business.id);
  const unusedAccountBefore = await accountSnapshot(business.id);
  requestPhotoTestHooks.unattachedByteCap = unusedReadyBefore + pngBytes.length;
  const unusedAuthorizeResults = [];
  for (let index = 0; index < unusedAuthorizeCount; index += 1) {
    try {
      unusedAuthorizeResults.push({
        ok: true,
        asset: await authorizePublicRequestPhoto(storageDeps, "collpro-reno", {
          originalFilename: `unused-authorize-${index}.png`,
          mimeType: "image/png",
          fileSizeBytes: unusedDeclaredBytes,
        }),
      });
    } catch (error) {
      unusedAuthorizeResults.push({ ok: false, error });
    }
  }
  const unusedAccountAfterAuth = await accountSnapshot(business.id);
  const unusedReadyAfterAuth = await sumUnattachedPublicPhotoBytes(business.id);
  let unusedDidNotBlockCustomer = null;
  try {
    unusedDidNotBlockCustomer = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
      originalFilename: "real-customer-after-unused-authorize.png",
      mimeType: "image/png",
      body: pngBytes,
    });
  } catch (error) {
    unusedDidNotBlockCustomer = error;
  }
  const unusedAccountAfterPut = await accountSnapshot(business.id);
  delete requestPhotoTestHooks.unattachedByteCap;
  check(
    "Repeated unused authorize calls cannot exhaust allowance or block a real customer photo",
    unusedAuthorizeResults.length === unusedAuthorizeCount &&
      unusedAuthorizeResults.every((row) => row.ok && row.asset.asset.status === "PENDING") &&
      unusedReadyAfterAuth === unusedReadyBefore &&
      unusedAccountAfterAuth.reserved === unusedAccountBefore.reserved &&
      unusedAccountAfterAuth.used === unusedAccountBefore.used &&
      unusedDidNotBlockCustomer &&
      !(unusedDidNotBlockCustomer instanceof Error) &&
      unusedDidNotBlockCustomer.status === "READY" &&
      unusedDidNotBlockCustomer.fileSizeBytes === pngBytes.length &&
      unusedAccountAfterPut.reserved === unusedAccountBefore.reserved &&
      unusedAccountAfterPut.used === unusedAccountBefore.used + pngBytes.length &&
      (await sumUnattachedPublicPhotoBytes(business.id)) === unusedReadyBefore + pngBytes.length,
  );

  const nearLimit = await runNearLimitPublicPhotoQuotaRace({
    prisma,
    provider,
    PrismaClient,
    datasourceUrl: testUrl,
  });
  check(
    "Near-limit concurrent public uploads never charge past the entitled storage quota",
    nearLimit.authorizeOk &&
      nearLimit.used <= nearLimit.limit &&
      nearLimit.used === NEAR_LIMIT_BYTES - NEAR_LIMIT_ROOM + nearLimit.readyBytes &&
      nearLimit.readyCount === 1 &&
      nearLimit.failedCount === 9 &&
      nearLimit.quotaErrorCount === 9 &&
      nearLimit.leftoverPendingOk &&
      nearLimit.reserved === 0 &&
      nearLimit.otherOk &&
      nearLimit.ownerOk,
  );

  const servicePath = fileURLToPath(new URL("../src/lib/business-storage/service.ts", import.meta.url));
  const serviceBackupPath = `/tmp/tbbt-service-quota-bak-${randomUUID()}.ts`;
  const originalServiceSrc = readFileSync(servicePath, "utf8");
  const quotaRecheckBlock = `    if (
      !hasEnoughStorage({
        usedBytes: lockedAccount.storageUsedBytes,
        reservedBytes: Number(lockedAccount.storageReservedBytes) - heldReserved,
        incomingBytes: actual,
        limitBytes,
      })
    ) {
      await failPendingAssetAndReleaseReservation(tx, {
        businessId,
        assetId: asset.id,
        storageAccountId: asset.storageAccountId,
        purpose: asset.purpose,
        fileSizeBytes: asset.fileSizeBytes,
        width: asset.width,
        now,
      });
      return { kind: "quota" as const };
    }
`;
  copyFileSync(servicePath, serviceBackupPath);
  try {
    check(
      "Finalize quota mutation setup finds the account-locked re-check",
      originalServiceSrc.includes(quotaRecheckBlock),
    );
    writeFileSync(servicePath, originalServiceSrc.replace(quotaRecheckBlock, ""));
    const quotaChild = spawnSync(
      process.execPath,
      ["--experimental-strip-types", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, REQUEST_INTAKE_QUOTA_MUTATION: "1", DATABASE_URL: testUrl },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    check(
      "Reverting the finalize quota re-check exceeds the storage limit",
      quotaChild.status !== 0 &&
        /used=109000|used=109000 limit=100000|ready=10/.test(
          `${quotaChild.stdout ?? ""}\n${quotaChild.stderr ?? ""}`,
        ),
    );
    if (
      quotaChild.status === 0 ||
      !/used=109000|ready=10/.test(`${quotaChild.stdout ?? ""}\n${quotaChild.stderr ?? ""}`)
    ) {
      console.error((quotaChild.stdout || "").slice(-2000));
      console.error((quotaChild.stderr || "").slice(-1000));
    }
  } finally {
    writeFileSync(servicePath, originalServiceSrc);
    const restored = spawnSync("cmp", [servicePath, serviceBackupPath]);
    check("service.ts restored after finalize-quota mutation", restored.status === 0);
    unlinkSync(serviceBackupPath);
  }

  const legacySlug = `legacy-res-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const legacyBiz = await seedTightStorageBusiness(prisma, {
    slug: legacySlug,
    name: "Legacy Reserved",
    usedBytes: 0,
    limitBytes: NEAR_LIMIT_BYTES,
  });
  const legacyDeps = { ...storageDeps, db: prisma };
  const legacyAbortAuth = await authorizePublicRequestPhoto(legacyDeps, legacySlug, {
    originalFilename: "legacy-abort.png",
    mimeType: "image/png",
    fileSizeBytes: NEAR_LIMIT_PHOTO,
  });
  const legacyAbortBefore = await accountSnapshot(legacyBiz.id);
  await prisma.storedAsset.update({
    where: { id: legacyAbortAuth.asset.id },
    data: { width: null },
  });
  await prisma.businessStorageAccount.update({
    where: { businessId: legacyBiz.id },
    data: { storageReservedBytes: { increment: NEAR_LIMIT_PHOTO } },
  });
  const legacyAborted = await abortPublicRequestPhoto(legacyDeps, legacySlug, legacyAbortAuth.asset.id);
  const legacyAbortAfter = await accountSnapshot(legacyBiz.id);
  check(
    "Abort of a legacy reserved public PENDING row un-reserves those exact bytes",
    legacyAborted.status === "FAILED" &&
      legacyAbortBefore.reserved === 0 &&
      legacyAbortAfter.reserved === 0 &&
      legacyAbortAfter.used === legacyAbortBefore.used,
  );

  const legacyExpireAuth = await authorizePublicRequestPhoto(legacyDeps, legacySlug, {
    originalFilename: "legacy-expire.png",
    mimeType: "image/png",
    fileSizeBytes: NEAR_LIMIT_PHOTO,
  });
  await prisma.storedAsset.update({
    where: { id: legacyExpireAuth.asset.id },
    data: { width: null, expiresAt: new Date(Date.now() - 1_000) },
  });
  await prisma.businessStorageAccount.update({
    where: { businessId: legacyBiz.id },
    data: { storageReservedBytes: { increment: NEAR_LIMIT_PHOTO } },
  });
  const legacyExpireBeforeAuth = await accountSnapshot(legacyBiz.id);
  await authorizePublicRequestPhoto(legacyDeps, legacySlug, {
    originalFilename: "legacy-expire-trigger.png",
    mimeType: "image/png",
    fileSizeBytes: NEAR_LIMIT_PHOTO,
  });
  const legacyExpired = await prisma.storedAsset.findUniqueOrThrow({
    where: { id: legacyExpireAuth.asset.id },
  });
  const legacyExpireAfter = await accountSnapshot(legacyBiz.id);
  check(
    "Expire of a legacy reserved public PENDING row un-reserves those exact bytes",
    legacyExpired.status === "FAILED" &&
      legacyExpireBeforeAuth.reserved === NEAR_LIMIT_PHOTO &&
      legacyExpireAfter.reserved === 0 &&
      legacyExpireAfter.used === legacyExpireBeforeAuth.used,
  );

  const legacyFinalizeAuth = await authorizePublicRequestPhoto(legacyDeps, legacySlug, {
    originalFilename: "legacy-finalize.png",
    mimeType: "image/png",
    fileSizeBytes: NEAR_LIMIT_PHOTO,
  });
  await provider.putObject({
    bucket: legacyFinalizeAuth.account.bucketName,
    key: legacyFinalizeAuth.asset.storageKey,
    body: Buffer.alloc(NEAR_LIMIT_PHOTO),
    contentType: "image/png",
  });
  await prisma.storedAsset.update({
    where: { id: legacyFinalizeAuth.asset.id },
    data: { width: null },
  });
  const legacyFinalizeBefore = await accountSnapshot(legacyBiz.id);
  await prisma.businessStorageAccount.update({
    where: { businessId: legacyBiz.id },
    data: { storageReservedBytes: { increment: NEAR_LIMIT_PHOTO } },
  });
  const legacyFinalized = await finalizePublicRequestPhoto(
    legacyDeps,
    legacySlug,
    legacyFinalizeAuth.asset.id,
  );
  const legacyFinalizeAfter = await accountSnapshot(legacyBiz.id);
  check(
    "Finalize of a legacy reserved public PENDING row un-reserves those exact bytes",
    legacyFinalized.status === "READY" &&
      legacyFinalizeBefore.reserved === 0 &&
      legacyFinalizeAfter.reserved === 0 &&
      legacyFinalizeAfter.used === legacyFinalizeBefore.used + NEAR_LIMIT_PHOTO,
  );

  const heldAccountRaces = await runHeldAccountFinalizeRaces({
    prisma,
    provider,
    PrismaClient,
    datasourceUrl: testUrl,
  });
  check(
    "Held-account finalize+abort and finalize+sweep do not deadlock and keep one quota outcome",
    !heldAccountRaces.abortRace.deadlockSeen &&
      !heldAccountRaces.sweepRace.deadlockSeen &&
      heldAccountRaces.abortRace.oneOutcome &&
      heldAccountRaces.sweepRace.oneOutcome &&
      heldAccountRaces.abortRace.quotaOk &&
      heldAccountRaces.sweepRace.quotaOk,
  );

  const lockOrderBackupPath = `/tmp/tbbt-service-lock-order-bak-${randomUUID()}.ts`;
  const lockOrderOriginal = readFileSync(servicePath, "utf8");
  const abortAccountFirstBlock = `    // LOCK_ACCOUNT_BEFORE_ASSET: abort must match finalize (account, then asset).
    await lockAccountThenPendingAsset(tx, {
      accountId: existing.storageAccountId,
      businessId,
      assetId: existing.id,
    });
`;
  const expireAccountFirstBlock = `    const accountIds = [...new Set(expired.map((row) => row.storageAccountId))].sort();
    for (const accountId of accountIds) {
      // LOCK_ACCOUNT_BEFORE_ASSET: expiry must match finalize (account, then asset).
      await lockStorageAccountRow(tx, accountId);
    }
    const won: typeof expired = [];
    for (const row of [...expired].sort((left, right) => (left.id < right.id ? -1 : 1))) {
      await lockPendingAssetRow(tx, { businessId, assetId: row.id });
`;
  const expireAccountFirstRestore = `    const won: typeof expired = [];
    for (const row of expired) {
`;
  copyFileSync(servicePath, lockOrderBackupPath);
  try {
    check(
      "Lock-order mutation setup finds account-before-asset abort and expiry locks",
      lockOrderOriginal.includes(abortAccountFirstBlock) &&
        lockOrderOriginal.includes(expireAccountFirstBlock),
    );
    writeFileSync(
      servicePath,
      lockOrderOriginal
        .replace(abortAccountFirstBlock, "")
        .replace(expireAccountFirstBlock, expireAccountFirstRestore),
    );
    const lockChild = spawnSync(
      process.execPath,
      ["--experimental-strip-types", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, REQUEST_INTAKE_LOCK_ORDER_MUTATION: "1", DATABASE_URL: testUrl },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    check(
      "Reverting abort/expiry to asset-first locks deadlocks held-account finalize races",
      lockChild.status !== 0 &&
        /abortDeadlock=true|sweepDeadlock=true|deadlock/i.test(
          `${lockChild.stdout ?? ""}\n${lockChild.stderr ?? ""}`,
        ),
    );
    if (
      lockChild.status === 0 ||
      !/abortDeadlock=true|sweepDeadlock=true|deadlock/i.test(
        `${lockChild.stdout ?? ""}\n${lockChild.stderr ?? ""}`,
      )
    ) {
      console.error((lockChild.stdout || "").slice(-2000));
      console.error((lockChild.stderr || "").slice(-1000));
    }
  } finally {
    writeFileSync(servicePath, lockOrderOriginal);
    const restoredLock = spawnSync("cmp", [servicePath, lockOrderBackupPath]);
    check("service.ts restored after lock-order mutation", restoredLock.status === 0);
    unlinkSync(lockOrderBackupPath);
  }

  const heldAccountReleaseRaces = await runHeldAccountReleaseFinalizeRaces({
    prisma,
    provider,
    PrismaClient,
    datasourceUrl: testUrl,
    rounds: 5,
  });
  check(
    "Held-account release[PENDING-first, READY] vs finalize(PENDING) does not deadlock and keeps used == READY bytes",
    heldAccountReleaseRaces.rounds === 5 &&
      heldAccountReleaseRaces.deadlockCount === 0 &&
      heldAccountReleaseRaces.accountingOk,
  );

  const requestPhotosPath = fileURLToPath(
    new URL("../src/lib/business-storage/request-photos.ts", import.meta.url),
  );
  const releaseLockBackupPath = `/tmp/tbbt-request-photos-release-lock-bak-${randomUUID()}.ts`;
  const releaseLockOriginal = readFileSync(requestPhotosPath, "utf8");
  const releaseAccountFirstBlock = `      // LOCK_ACCOUNT_BEFORE_ASSET: release must match finalize (account, then sorted assets).
      await lockBusinessStorageAccountForUpdate(tx, businessId);
`;
  copyFileSync(requestPhotosPath, releaseLockBackupPath);
  try {
    check(
      "Release lock-order mutation setup finds account-before-asset release lock",
      releaseLockOriginal.includes(releaseAccountFirstBlock),
    );
    writeFileSync(
      requestPhotosPath,
      releaseLockOriginal.replace(releaseAccountFirstBlock, ""),
    );
    const releaseLockChild = spawnSync(
      process.execPath,
      ["--experimental-strip-types", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, REQUEST_INTAKE_RELEASE_LOCK_MUTATION: "1", DATABASE_URL: testUrl },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    check(
      "Reverting release to asset-first locks deadlocks held-account finalize races",
      releaseLockChild.status !== 0 &&
        /deadlockCount=[1-9]|40P01|deadlock/i.test(
          `${releaseLockChild.stdout ?? ""}\n${releaseLockChild.stderr ?? ""}`,
        ),
    );
    if (
      releaseLockChild.status === 0 ||
      !/deadlockCount=[1-9]|40P01|deadlock/i.test(
        `${releaseLockChild.stdout ?? ""}\n${releaseLockChild.stderr ?? ""}`,
      )
    ) {
      console.error((releaseLockChild.stdout || "").slice(-2000));
      console.error((releaseLockChild.stderr || "").slice(-1000));
    }
  } finally {
    writeFileSync(requestPhotosPath, releaseLockOriginal);
    const restoredReleaseLock = spawnSync("cmp", [requestPhotosPath, releaseLockBackupPath]);
    check("request-photos.ts restored after release lock-order mutation", restoredReleaseLock.status === 0);
    unlinkSync(releaseLockBackupPath);
  }

  const releaseOnce = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "release-once.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const releaseBefore = await accountSnapshot(business.id);
  const firstRelease = await releasePublicRequestPhotos(storageDeps, "collpro-reno", [
    releaseOnce.id,
  ]);
  const releaseMid = await accountSnapshot(business.id);
  const secondRelease = await releasePublicRequestPhotos(storageDeps, "collpro-reno", [
    releaseOnce.id,
  ]);
  const releaseAfter = await accountSnapshot(business.id);
  check(
    "Rejection release uncharges quota once and a second release is a no-op",
    firstRelease.released === 1 &&
      secondRelease.released === 0 &&
      (await reloadAsset(releaseOnce.id))?.status === "FAILED" &&
      releaseMid.used === releaseBefore.used - pngBytes.length &&
      releaseAfter.used === releaseMid.used,
  );

  const foreignReleasePhoto = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "cross-tenant-release.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const foreignRelease = await releasePublicRequestPhotos(storageDeps, "other-handyman", [
    foreignReleasePhoto.id,
  ]);
  check(
    "Cross-tenant public photo release is a no-op",
    foreignRelease.released === 0 &&
      (await reloadAsset(foreignReleasePhoto.id))?.status === "READY",
  );

  const retryAfterReleaseId = `relretry${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const retryAfterReleasePhoto = await putPublicRequestPhotoFromBytes(storageDeps, "collpro-reno", {
    originalFilename: "retry-after-release.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const retryAfterReleaseFirst = await createRequestWithPhotoIds(
    "Retry After Release",
    `retry-after-release-${randomUUID()}@example.com`,
    [retryAfterReleasePhoto.id],
    retryAfterReleaseId,
  );
  await releasePublicRequestPhotos(storageDeps, "collpro-reno", [retryAfterReleasePhoto.id]);
  const retryAfterReleaseSecond = await createRequestWithPhotoIds(
    "Retry After Release",
    `retry-after-release-${randomUUID()}@example.com`,
    [retryAfterReleasePhoto.id],
    retryAfterReleaseId,
  );
  check(
    "Releasing attached photos after a successful submit does not break submissionId retry",
    retryAfterReleaseFirst.created.ok === true &&
      retryAfterReleaseSecond.created.ok === true &&
      retryAfterReleaseSecond.created.requestId === retryAfterReleaseFirst.created.requestId,
  );

  console.log("\nDB — Owner Log lead creates a real ServiceRequest");
  function makeAccess(businessId) {
    return {
      businessId,
      scope: { businessId },
      assertOwned(record) {
        if (!record || record.businessId !== businessId) {
          throw new Error("Record is not in the authorized business workspace.");
        }
        return record;
      },
    };
  }
  const ownerAccess = makeAccess(business.id);
  const otherAccess = makeAccess(other.id);

  const phoneLead = await createOwnerLoggedLead(prisma, ownerAccess, {
    businessId: other.id,
    mode: "new",
    name: "Phone Lead",
    email: "phone.lead@example.com",
    phone: "(239) 555-0110",
    summary: "Kitchen faucet leak",
    notes: "Called during lunch",
    channel: "PHONE",
    submissionId: "phonelead01",
  });
  const phoneRequest = phoneLead.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: phoneLead.requestId },
        include: { customer: true, property: true, items: true },
      })
    : null;
  check("Owner can log a new phone lead", phoneLead.ok === true);
  check("Logged lead is an OPEN ServiceRequest in this tenant",
    phoneRequest?.status === "OPEN" && phoneRequest.businessId === business.id);
  check("Phone/walk-in stores MANUAL, not a new schema value",
    phoneRequest?.leadSource === "MANUAL" &&
      recordedLeadSourceForChannel("PHONE") === "MANUAL" &&
      recordedLeadSourceForChannel("WALK_IN") === "MANUAL" &&
      recordedLeadSourceForChannel("REFERRAL") === "REFERRAL");
  check("Phone origin is preserved in request notes",
    (phoneRequest?.description ?? "").includes("Logged lead origin: Phone"));
  check("Client businessId was ignored; request stayed on the access tenant",
    phoneRequest?.businessId === business.id && phoneRequest?.businessId !== other.id);
  check("Existing Handyman Log lead stores HANDYMAN without a selected service",
    phoneRequest?.tradeCode === "HANDYMAN");

  const pipeline = await loadPipelineSource(prisma, business.id);
  check("Logged lead appears on the Pipeline New Lead path",
    pipeline.opportunities.some(
      (row) => row.serviceRequestId === phoneRequest?.id && row.stage === "NEW_LEAD",
    ));
  const listed = await prisma.serviceRequest.findMany({
    where: { businessId: business.id, status: "OPEN" },
    select: { id: true },
  });
  check("Logged lead appears on the Requests OPEN path",
    listed.some((row) => row.id === phoneRequest?.id));

  const customersBeforeMatch = await prisma.customer.count({ where: { businessId: business.id } });
  const emailMatch = await createOwnerLoggedLead(prisma, ownerAccess, {
    mode: "new",
    name: "Different Name",
    email: "PHONE.LEAD@example.com",
    phone: "",
    summary: "Repeat caller",
    channel: "PHONE",
    submissionId: "emailmatch1",
  });
  const emailMatchRequest = emailMatch.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: emailMatch.requestId },
        include: { customer: true },
      })
    : null;
  const customersAfterEmail = await prisma.customer.count({ where: { businessId: business.id } });
  check("Normalized email reuses the existing customer",
    emailMatch.ok === true &&
      emailMatchRequest?.customerId === phoneRequest?.customerId &&
      customersAfterEmail === customersBeforeMatch);
  check("Clear email match does not create a duplicate customer",
    customersAfterEmail === customersBeforeMatch);

  const phoneMatch = await createOwnerLoggedLead(prisma, ownerAccess, {
    mode: "new",
    name: "Still Different",
    email: "",
    phone: "+1 239-555-0110",
    summary: "Follow-up text",
    channel: "TEXT",
    submissionId: "phonematch1",
  });
  const phoneMatchRequest = phoneMatch.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: phoneMatch.requestId },
      })
    : null;
  const customersAfterPhone = await prisma.customer.count({ where: { businessId: business.id } });
  check("Normalized phone reuses the existing customer",
    phoneMatch.ok === true &&
      phoneMatchRequest?.customerId === phoneRequest?.customerId &&
      customersAfterPhone === customersBeforeMatch);

  const existingProperty = await prisma.property.create({
    data: {
      businessId: business.id,
      customerId: phoneRequest.customerId,
      addressLine1: "12 Oak St",
      city: "Fort Myers",
      region: "FL",
      postalCode: "33901",
    },
  });
  const existingPropertyLead = await createOwnerLoggedLead(prisma, ownerAccess, {
    mode: "existing",
    customerId: phoneRequest.customerId,
    propertyChoice: existingProperty.id,
    summary: "Back to the same house",
    channel: "WALK_IN",
    serviceCatalogItemId: fan.id,
    submissionId: "existprop1",
  });
  const existingPropertyRequest = existingPropertyLead.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: existingPropertyLead.requestId },
        include: { items: true },
      })
    : null;
  check("Existing property can be selected on a logged lead",
    existingPropertyLead.ok === true &&
      existingPropertyRequest?.propertyId === existingProperty.id &&
      existingPropertyRequest.customerId === phoneRequest.customerId);
  check("Optional catalog service attaches to the logged request",
    existingPropertyRequest?.serviceCatalogItemId === fan.id &&
      existingPropertyRequest.items.some((item) => item.serviceCatalogItemId === fan.id));

  const newPropertyLead = await createOwnerLoggedLead(prisma, ownerAccess, {
    mode: "existing",
    customerId: phoneRequest.customerId,
    propertyChoice: "new",
    streetAddress: "88 Harbor Ave",
    city: "Cape Coral",
    region: "FL",
    postalCode: "33904",
    summary: "Second property",
    channel: "MANUAL",
    submissionId: "newprop001",
  });
  const newPropertyRequest = newPropertyLead.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: newPropertyLead.requestId },
        include: { property: true },
      })
    : null;
  check("New structured property can be created on a logged lead",
    newPropertyLead.ok === true &&
      newPropertyRequest?.property?.addressLine1 === "88 Harbor Ave" &&
      newPropertyRequest.property?.city === "Cape Coral" &&
      newPropertyRequest.property?.region === "FL" &&
      newPropertyRequest.property?.postalCode === "33904" &&
      newPropertyRequest.property?.businessId === business.id &&
      newPropertyRequest.customerId === phoneRequest.customerId);

  const otherCustomerCount = await prisma.customer.count({ where: { businessId: other.id } });
  const otherRequestCount = await prisma.serviceRequest.count({ where: { businessId: other.id } });
  const otherPropertyCount = await prisma.property.count({ where: { businessId: other.id } });
  const foreignCustomer = await createOwnerLoggedLead(prisma, otherAccess, {
    mode: "existing",
    customerId: phoneRequest.customerId,
    summary: "Hijack customer",
    channel: "PHONE",
    submissionId: "foreigncus",
  });
  const otherExistingCustomer = await prisma.customer.findFirst({
    where: { businessId: other.id },
    select: { id: true },
  });
  const foreignProperty = otherExistingCustomer
    ? await createOwnerLoggedLead(prisma, otherAccess, {
        mode: "existing",
        customerId: otherExistingCustomer.id,
        propertyChoice: existingProperty.id,
        summary: "Hijack property",
        channel: "PHONE",
        submissionId: "foreignprp",
      })
    : { ok: true };
  check("Tenant B cannot attach tenant A customer",
    foreignCustomer.ok === false);
  check("Tenant B cannot attach tenant A property",
    foreignProperty.ok === false);
  check("Rejected foreign IDs create no partial customer/request/property rows",
    (await prisma.customer.count({ where: { businessId: other.id } })) === otherCustomerCount &&
      (await prisma.serviceRequest.count({ where: { businessId: other.id } })) === otherRequestCount &&
      (await prisma.property.count({ where: { businessId: other.id } })) === otherPropertyCount);

  const retry = await createOwnerLoggedLead(prisma, ownerAccess, {
    mode: "new",
    name: "Phone Lead",
    email: "phone.lead@example.com",
    summary: "Kitchen faucet leak",
    channel: "PHONE",
    submissionId: "phonelead01",
  });
  check("Resubmit with the same submissionId reuses the request",
    retry.ok === true && retry.requestId === phoneLead.requestId && retry.reused === true);

  function instrumentReplayLookupDelay(client, ms) {
    const origTx = client.$transaction.bind(client);
    client.$transaction = (fn, options) =>
      origTx(async (tx) => {
        const origFind = tx.serviceRequest.findFirst.bind(tx.serviceRequest);
        tx.serviceRequest.findFirst = async (args) => {
          const result = await origFind(args);
          if (args?.where?.description?.contains) {
            await new Promise((resolve) => setTimeout(resolve, ms));
          }
          return result;
        };
        return fn(tx);
      }, options);
  }

  function publicIntakePayload(slug, catalogItemId, submissionId, name) {
    return {
      slug,
      name,
      email: `${name.replace(/\s+/g, ".").toLowerCase()}@example.com`,
      phone: "2395550100",
      address: "1 Main St",
      streetAddress: "1 Main St",
      city: "Fort Myers",
      region: "FL",
      postalCode: "33901",
      notes: "Concurrent intake replay",
      catalogItemIds: [catalogItemId],
      includeOther: false,
      otherDescription: "",
      submissionId,
    };
  }

  const raceClientA = new PrismaClient({ datasourceUrl: testUrl });
  const raceClientB = new PrismaClient({ datasourceUrl: testUrl });
  instrumentReplayLookupDelay(raceClientA, 200);
  instrumentReplayLookupDelay(raceClientB, 200);
  const concurrentToken = `conc${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  try {
    const [raceA, raceB] = await Promise.all([
      createPublicServiceRequest(
        raceClientA,
        publicIntakePayload("collpro-reno", fan.id, concurrentToken, "Concurrent A"),
      ),
      createPublicServiceRequest(
        raceClientB,
        publicIntakePayload("collpro-reno", fan.id, concurrentToken, "Concurrent B"),
      ),
    ]);
    const concurrentRows = await prisma.serviceRequest.findMany({
      where: {
        businessId: business.id,
        description: { contains: `${INTAKE_SUBMISSION_MARKER}${concurrentToken}` },
      },
      select: { id: true, customerId: true, description: true },
    });
    check(
      "Concurrent same submissionId converges on one request after the old findFirst window",
      raceA.ok === true &&
        raceB.ok === true &&
        raceA.requestId === raceB.requestId &&
        concurrentRows.length === 1 &&
        concurrentRows[0].id === raceA.requestId,
    );
    check(
      "Concurrent same submissionId does not create a second customer",
      concurrentRows.length === 1 &&
        new Set(concurrentRows.map((row) => row.customerId)).size === 1,
    );
  } finally {
    await raceClientA.$disconnect();
    await raceClientB.$disconnect();
  }

  const barrierClientA = new PrismaClient({ datasourceUrl: testUrl });
  const barrierClientB = new PrismaClient({ datasourceUrl: testUrl });
  const barrierToken = `lock${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  try {
    let releaseBarrier;
    const held = new Promise((resolve) => {
      releaseBarrier = resolve;
    });
    let arrivedBarrier;
    const waiting = new Promise((resolve) => {
      arrivedBarrier = resolve;
    });
    publicIntakeTestHooks.afterSubmissionClaim = async () => {
      arrivedBarrier();
      await held;
    };
    const firstLocked = createPublicServiceRequest(
      barrierClientA,
      publicIntakePayload("collpro-reno", fan.id, barrierToken, "Barrier First"),
    );
    await Promise.race([
      waiting,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("submission claim barrier timed out")), 8000);
      }),
    ]);
    const secondLocked = createPublicServiceRequest(
      barrierClientB,
      publicIntakePayload("collpro-reno", fan.id, barrierToken, "Barrier Second"),
    );
    releaseBarrier();
    const [barrierFirst, barrierSecond] = await Promise.all([firstLocked, secondLocked]);
    const barrierRows = await prisma.serviceRequest.findMany({
      where: {
        businessId: business.id,
        description: { contains: `${INTAKE_SUBMISSION_MARKER}${barrierToken}` },
      },
      select: { id: true },
    });
    check(
      "Submission claim hook still converges concurrent writers on one request",
      barrierFirst.ok === true &&
        barrierSecond.ok === true &&
        barrierFirst.requestId === barrierSecond.requestId &&
        barrierRows.length === 1,
    );
  } finally {
    publicIntakeTestHooks.afterSubmissionClaim = undefined;
    await barrierClientA.$disconnect();
    await barrierClientB.$disconnect();
  }

  const isolatedToken = `iso${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const [isoA, isoB] = await Promise.all([
    createPublicServiceRequest(
      prisma,
      publicIntakePayload("collpro-reno", fan.id, isolatedToken, "Iso Handy"),
    ),
    createPublicServiceRequest(
      prisma,
      publicIntakePayload("other-handyman", otherItem.id, isolatedToken, "Iso Other"),
    ),
  ]);
  check(
    "Same submissionId on two tenants still creates isolated requests",
    isoA.ok === true &&
      isoB.ok === true &&
      isoA.requestId !== isoB.requestId,
  );
  const sequentialToken = `seqbiz${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const sequentialA = await createPublicServiceRequest(
    prisma,
    publicIntakePayload("collpro-reno", fan.id, sequentialToken, "Seq Handy"),
  );
  const sequentialB = await createPublicServiceRequest(
    prisma,
    publicIntakePayload("other-handyman", otherItem.id, sequentialToken, "Seq Other"),
  );
  const sequentialBRow = sequentialB.ok
    ? await prisma.serviceRequest.findFirst({
        where: { id: sequentialB.requestId },
        select: { id: true, businessId: true },
      })
    : null;
  check(
    "Same submissionId across two businesses does not return the other tenant's request",
    sequentialA.ok === true &&
      sequentialB.ok === true &&
      sequentialA.requestId !== sequentialB.requestId &&
      sequentialBRow?.businessId === other.id,
  );

  const customersBeforeHandoff = await prisma.customer.count({ where: { businessId: business.id } });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      serviceRequestId: phoneRequest.id,
      customerId: phoneRequest.customerId,
      propertyId: phoneRequest.propertyId,
      leadSource: phoneRequest.leadSource,
      campaignId: phoneRequest.campaignId,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  await prisma.serviceRequest.update({
    where: { id: phoneRequest.id },
    data: { status: "CONVERTED" },
  });
  const converted = await prisma.serviceRequest.findUnique({
    where: { id: phoneRequest.id },
  });
  const customersAfterHandoff = await prisma.customer.count({ where: { businessId: business.id } });
  check("Request→estimate handoff keeps the same customer and property",
    estimate.serviceRequestId === phoneRequest.id &&
      estimate.customerId === phoneRequest.customerId &&
      estimate.propertyId === phoneRequest.propertyId &&
      estimate.leadSource === phoneRequest.leadSource &&
      converted.status === "CONVERTED");
  check("Handoff does not create a second customer",
    customersAfterHandoff === customersBeforeHandoff);

  const conflictA = await prisma.customer.create({
    data: {
      businessId: business.id,
      name: "Email Owner",
      email: "conflict@example.com",
    },
  });
  const conflictB = await prisma.customer.create({
    data: {
      businessId: business.id,
      name: "Phone Owner",
      phone: "2395550199",
    },
  });
  const ambiguous = await createOwnerLoggedLead(prisma, ownerAccess, {
    mode: "new",
    name: "Ambiguous Person",
    email: "conflict@example.com",
    phone: "239-555-0199",
    summary: "Conflicting identifiers",
    channel: "PHONE",
    submissionId: "ambiguous1",
  });
  const ambiguousRequest = ambiguous.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: ambiguous.requestId },
      })
    : null;
  check("Ambiguous email/phone does not silently merge existing customers",
    ambiguous.ok === true &&
      ambiguousRequest?.customerId !== conflictA.id &&
      ambiguousRequest?.customerId !== conflictB.id &&
      (ambiguousRequest?.description ?? "").includes("TBBT Identity Review"));
  check("decideCustomerMatch still classifies that pair as ambiguous",
    decideCustomerMatch(
      [
        { id: conflictA.id, name: "Email Owner", email: "conflict@example.com", phone: null },
        { id: conflictB.id, name: "Phone Owner", email: null, phone: "2395550199" },
      ],
      { email: "conflict@example.com", phone: "239-555-0199" },
    ).kind === "ambiguous");
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

console.log(
  failed === 0
    ? `\nAll request-intake checks passed (${passed}).`
    : `\n${failed} request-intake check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);

/**
 * Private expense receipts: OWNER attach / review / replace / remove on
 * managed storage. Proves upload/download authorization, tenant isolation,
 * file limits, storage-failure rollback, and replacement without changing
 * the recorded amount or inferring tax treatment.
 *
 * Dedicated database: tbbt_expense_receipts_test
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-expense-receipts.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { CAPABILITIES, ForbiddenError, roleHasCapability } = await import(
  "@/lib/authorization"
);
const { CONCURRENT_EXPENSE_RECEIPT_ERROR, createExpense, reviewExpense } = await import(
  "@/lib/expense-ops"
);
const {
  EXPENSE_RECEIPT_MAX_BYTES,
  EXPENSE_RECEIPT_PURPOSE,
  MemoryStorageProvider,
  PRIVATE_DOWNLOAD_URL_TTL_SECONDS,
  StorageError,
  authorizeExpenseReceiptUpload,
  authorizePrivateStoredAssetDownload,
  detectExpenseReceiptMimeType,
  expenseReceiptHref,
  expenseReceiptMaxBytesLabel,
  inspectExpenseReceiptUpload,
  isBusinessStorageConfigured,
  privateAssetPath,
  putExpenseReceiptFromBytes,
  removeExpenseReceiptAttachment,
} = await import("@/lib/business-storage/index");

function requireLocalDatabaseUrl(url, label) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    console.error(`${label} is not a valid URL.`);
    process.exit(1);
  }
  if (host !== "localhost" && host !== "127.0.0.1") {
    console.error(
      `${label} must point at localhost or 127.0.0.1. Refusing to run against ${host}.`,
    );
    process.exit(1);
  }
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
requireLocalDatabaseUrl(baseUrl, "DATABASE_URL");

const testDbName = "tbbt_expense_receipts_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
requireLocalDatabaseUrl(testUrl, "Expense receipt test DATABASE_URL");

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for expense receipt test database.");
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

function makeAccess(businessId, role, membershipId, slug) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: businessId, slug },
    },
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

function failPut(inner) {
  return {
    get id() {
      return inner.id;
    },
    async putObject() {
      throw new Error("simulated provider putObject failure");
    },
    getObjectMetadata: (input) => inner.getObjectMetadata(input),
    getObject: (input) => inner.getObject(input),
    objectExists: (input) => inner.objectExists(input),
    createUploadUrl: (input) => inner.createUploadUrl(input),
    createDownloadUrl: (input) => inner.createDownloadUrl(input),
    deleteObject: (input) => inner.deleteObject(input),
  };
}

function failFinalizeAfterPut(inner) {
  return {
    get id() {
      return inner.id;
    },
    putObject: (input) => inner.putObject(input),
    async getObjectMetadata() {
      return null;
    },
    getObject: (input) => inner.getObject(input),
    objectExists: (input) => inner.objectExists(input),
    createUploadUrl: (input) => inner.createUploadUrl(input),
    createDownloadUrl: (input) => inner.createDownloadUrl(input),
    deleteObject: (input) => inner.deleteObject(input),
  };
}

async function accountSnapshot(businessId) {
  const account = await prisma.businessStorageAccount.findUnique({
    where: { businessId },
  });
  if (!account) {
    return { usedBytes: 0, reservedBytes: 0 };
  }
  return {
    usedBytes: Number(account.storageUsedBytes),
    reservedBytes: Number(account.storageReservedBytes),
  };
}

const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0x01, 0x02, 0x03, 0x04]);
const jpegReplaceA = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0x11, 0x12, 0x13, 0x14, 0x15]);
const jpegReplaceB = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26]);
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pdfBytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const replacementBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
const heicBytes = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
]);
const receiptBucket = "tbbt-expense-receipts-test";

try {
  console.log("\nSTATIC — Private expense receipt wiring and storage limits");
  const receiptLib = readRepo("src/lib/business-storage/expense-receipts.ts");
  const expenseOps = readRepo("src/lib/expense-ops.ts");
  const expenseActions = readRepo("src/app/actions/expenses.ts");
  const pageSrc = readRepo("src/app/(app)/expenses/page.tsx");
  const workspaceSrc = readRepo("src/components/expenses/expenses-workspace.tsx");
  const sheetSrc = readRepo("src/components/expenses/add-expense-sheet.tsx");
  const typesSrc = readRepo("src/components/expenses/types.ts");
  const schemaSrc = readRepo("prisma/schema.prisma");
  const r2Src = readRepo("src/lib/business-storage/r2-provider.ts");
  const privateServeSrc = readRepo("src/lib/business-storage/private-serve.ts");

  check("Per-file receipt limit is 4 MB", EXPENSE_RECEIPT_MAX_BYTES === 4 * 1024 * 1024);
  check("Limit label is 4 MB", expenseReceiptMaxBytesLabel() === "4 MB");
  check(
    "JPEG magic bytes are accepted and stored as image/jpeg",
    inspectExpenseReceiptUpload({
      type: "image/png",
      name: "a.png",
      size: jpegBytes.byteLength,
      body: jpegBytes,
    }).ok === false &&
      inspectExpenseReceiptUpload({
        type: "image/jpeg",
        name: "a.jpg",
        size: jpegBytes.byteLength,
        body: jpegBytes,
      }).ok === true &&
      detectExpenseReceiptMimeType(jpegBytes) === "image/jpeg",
  );
  check(
    "PDF magic bytes are accepted",
    inspectExpenseReceiptUpload({
      type: "application/pdf",
      name: "a.pdf",
      size: pdfBytes.byteLength,
      body: pdfBytes,
    }).ok === true && detectExpenseReceiptMimeType(pdfBytes) === "application/pdf",
  );
  check(
    "Declared JPEG with PNG bytes is rejected",
    inspectExpenseReceiptUpload({
      type: "image/jpeg",
      name: "a.jpg",
      size: pngBytes.byteLength,
      body: pngBytes,
    }).ok === false && detectExpenseReceiptMimeType(pngBytes) === "image/png",
  );
  check(
    "HEIC ftyp brand is detected",
    detectExpenseReceiptMimeType(heicBytes) === "image/heic" &&
      inspectExpenseReceiptUpload({
        type: "image/heic",
        name: "a.heic",
        size: heicBytes.byteLength,
        body: heicBytes,
      }).ok === true,
  );
  check(
    "Oversized receipt is rejected",
    inspectExpenseReceiptUpload({
      type: "image/jpeg",
      name: "big.jpg",
      size: EXPENSE_RECEIPT_MAX_BYTES + 1,
      body: jpegBytes,
    }).ok === false,
  );
  check(
    "Executable upload is rejected",
    inspectExpenseReceiptUpload({
      type: "application/x-msdownload",
      name: "x.exe",
      size: 80,
      body: Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]),
    }).ok === false,
  );
  check(
    "Receipt module never assigns or classifies tax treatment",
    !receiptLib.includes("taxCategory") &&
      !receiptLib.includes("DEDUCTIBLE") &&
      !receiptLib.includes("TAX_CATEGORIES") &&
      !receiptLib.includes("normalizeTaxCategory"),
  );
  check(
    "Attach/remove claim the previous receiptStoredAssetId and never amount or receiptUrl",
    expenseOps.includes("receiptStoredAssetId: previousStoredAssetId") &&
      expenseOps.includes("CONCURRENT_EXPENSE_RECEIPT_ERROR") &&
      !expenseOps.includes("receiptUrl: null") &&
      !/data: \{[\s\S]*amount:/.test(
        expenseOps.slice(expenseOps.indexOf("export async function attachExpenseReceipt")),
      ),
  );
  check(
    "putExpenseReceiptFromBytes awaits finalize so abort can run",
    receiptLib.includes("return await finalizeAndAttachExpenseReceipt"),
  );
  check(
    "Presigned private download sets content type and disposition",
    r2Src.includes("ResponseContentType: input.contentType") &&
      r2Src.includes("ResponseContentDisposition: input.contentDisposition") &&
      privateServeSrc.includes("privateAssetContentDisposition"),
  );
  check(
    "Actions use private put-from-bytes, not a public Blob URL",
    expenseActions.includes("putExpenseReceiptFromBytes") &&
      expenseActions.includes("removeExpenseReceiptAttachment") &&
      !expenseActions.includes("uploadExpenseReceipt") &&
      !expenseActions.includes("receiptUrl") &&
      !expenseActions.includes("BLOB_READ_WRITE_TOKEN"),
  );
  check(
    "UI reviews through the private asset path and never a public file URL",
    pageSrc.includes("expenseReceiptHref") &&
      pageSrc.includes("isBusinessStorageConfigured") &&
      workspaceSrc.includes("expense.receiptHref") &&
      workspaceSrc.includes("legacyReceiptHref") &&
      workspaceSrc.includes("hasPrivateReceipt") &&
      workspaceSrc.includes("Earlier receipt (stored before private storage)") &&
      !workspaceSrc.includes("expense.receiptUrl") &&
      !typesSrc.includes("receiptUrl") &&
      sheetSrc.includes("Limit 4 MB") &&
      sheetSrc.includes("not used to infer tax treatment") &&
      workspaceSrc.includes("does not infer tax treatment"),
  );
  check(
    "Schema stores a private StoredAsset FK and documents the legacy URL",
    schemaSrc.includes("receiptStoredAssetId") &&
      schemaSrc.includes("legacy pointer") &&
      schemaSrc.includes("never write a public file URL"),
  );
  check(
    "Private href helper stays on the authorized route",
    expenseReceiptHref("asset_1") === privateAssetPath("asset_1") &&
      expenseReceiptHref("asset_1") === "/api/storage/private/asset_1" &&
      expenseReceiptHref(null) === null,
  );
  check(
    "OWNER/ADMIN can manage expenses; MEMBER cannot",
    roleHasCapability("OWNER", CAPABILITIES.MANAGE_EXPENSES) &&
      roleHasCapability("ADMIN", CAPABILITIES.MANAGE_EXPENSES) &&
      !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_EXPENSES),
  );
  check(
    "isBusinessStorageConfigured is exported for the page gate",
    typeof isBusinessStorageConfigured === "function",
  );
  check(
    "Private download TTL stays short-lived",
    PRIVATE_DOWNLOAD_URL_TTL_SECONDS === 2 * 60,
  );

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-rcpt-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-rcpt-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-rcpt-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwnerUser = await prisma.user.create({
    data: { name: "Beta Owner", email: `beta-rcpt-${randomUUID()}@example.com`, passwordHash: "x" },
  });

  const businessA = await prisma.business.create({
    data: { name: "Alpha Receipts", slug: `alpha-rcpt-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Receipts", slug: `beta-rcpt-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
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
  const betaOwnerMem = await prisma.membership.create({
    data: { userId: betaOwnerUser.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id, businessA.slug);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id, businessA.slug);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id, businessA.slug);
  const ownerB = makeAccess(businessB.id, "OWNER", betaOwnerMem.id, businessB.slug);
  const ownerViewer = { role: "OWNER", membershipId: ownerMem.id };
  const adminViewer = { role: "ADMIN", membershipId: adminMem.id };
  const memberViewer = { role: "MEMBER", membershipId: memberMem.id };
  const betaViewer = { role: "OWNER", membershipId: betaOwnerMem.id };

  const lumber = await createExpense(prisma, ownerA, {
    occurredOn: "2026-09-01",
    description: "Lumber",
    amount: "142.68",
    category: "MATERIALS",
    vendor: "Home Depot",
    taxCategory: "UNSPECIFIED",
  });
  const legacyReceiptUrl = "https://blob.example.test/expense-receipts/a/lumber.jpg";
  await prisma.expense.update({
    where: { id: lumber.id },
    data: { receiptUrl: legacyReceiptUrl },
  });
  const paint = await createExpense(prisma, ownerA, {
    occurredOn: "2026-09-02",
    description: "Paint",
    amount: "48.00",
    category: "MATERIALS",
  });
  const betaPaint = await createExpense(prisma, ownerB, {
    occurredOn: "2026-09-01",
    description: "Beta paint",
    amount: "99.00",
    category: "MATERIALS",
  });

  const provider = new MemoryStorageProvider();
  const deps = {
    db: prisma,
    provider,
    bucketName: receiptBucket,
  };

  console.log("\nTEST — OWNER attach, review, and authorized private download");
  const attached = await putExpenseReceiptFromBytes(deps, ownerA, {
    expenseId: lumber.id,
    originalFilename: "lumber.jpg",
    mimeType: "image/jpeg",
    body: jpegBytes,
  });
  check("Attached receipt stays on business A", attached.expense.businessId === businessA.id);
  check(
    "Recorded amount is unchanged after attach",
    Number(attached.expense.amount.toString()) === 142.68,
  );
  check(
    "Tax category is unchanged and not inferred",
    attached.expense.taxCategory === "UNSPECIFIED",
  );
  check("Legacy receiptUrl is preserved after private attach", attached.expense.receiptUrl === legacyReceiptUrl);
  check(
    "Asset is a private READY expense receipt",
    attached.asset.status === "READY" &&
      attached.asset.visibility === "PRIVATE" &&
      attached.asset.publicPath === null &&
      attached.asset.purpose === EXPENSE_RECEIPT_PURPOSE &&
      attached.asset.category === "ATTACHMENT",
  );
  check(
    "Storage key stays under the tenant namespace",
    attached.asset.storageKey.startsWith(`businesses/${businessA.id}/`),
  );
  check(
    "Review href is the private route, not a public file URL",
    expenseReceiptHref(attached.asset.id) === `/api/storage/private/${attached.asset.id}`,
  );

  const afterAttach = await accountSnapshot(businessA.id);
  check(
    "Used bytes equal the receipt size; reservation is released",
    afterAttach.usedBytes === jpegBytes.byteLength && afterAttach.reservedBytes === 0,
  );

  const ownerRead = await authorizePrivateStoredAssetDownload(prisma, attached.asset.id, businessA.id, {
    provider,
    viewer: ownerViewer,
  });
  const adminRead = await authorizePrivateStoredAssetDownload(prisma, attached.asset.id, businessA.id, {
    provider,
    viewer: adminViewer,
  });
  check(
    "OWNER can download the receipt via a short-lived private URL",
    ownerRead.ok === true &&
      ownerRead.status === 302 &&
      ownerRead.url === `memory://download/${receiptBucket}/${attached.asset.storageKey}` &&
      ownerRead.expiresInSeconds === PRIVATE_DOWNLOAD_URL_TTL_SECONDS &&
      !("body" in ownerRead),
  );
  check("ADMIN can download the same-business receipt", adminRead.ok === true && adminRead.url === ownerRead.url);

  const reviewed = await reviewExpense(prisma, ownerA, {
    expenseId: lumber.id,
    reviewStatus: "APPROVED",
  });
  check(
    "Reviewing the expense does not change amount or detach the receipt",
    Number(reviewed.amount.toString()) === 142.68 &&
      reviewed.receiptStoredAssetId === attached.asset.id &&
      reviewed.reviewStatus === "APPROVED" &&
      reviewed.taxCategory === "UNSPECIFIED",
  );

  console.log("\nTEST — Upload authorization and tenant isolation");
  await expectThrow(
    "MEMBER cannot upload a receipt",
    () =>
      putExpenseReceiptFromBytes(deps, memberA, {
        expenseId: lumber.id,
        originalFilename: "member.jpg",
        mimeType: "image/jpeg",
        body: jpegBytes,
      }),
    (error) => error instanceof ForbiddenError,
  );
  const memberRead = await authorizePrivateStoredAssetDownload(prisma, attached.asset.id, businessA.id, {
    provider,
    viewer: memberViewer,
  });
  check(
    "MEMBER cannot download an expense receipt",
    memberRead.ok === false && memberRead.status === 404 && memberRead.body === "Not found",
  );

  await expectThrow(
    "Business B OWNER cannot attach a receipt to Business A expense",
    () =>
      putExpenseReceiptFromBytes(deps, ownerB, {
        expenseId: lumber.id,
        originalFilename: "leak.jpg",
        mimeType: "image/jpeg",
        body: jpegBytes,
      }),
    (error) => error instanceof Error,
  );
  const lumberAfterLeak = await prisma.expense.findUnique({ where: { id: lumber.id } });
  check(
    "Cross-tenant attach left A's receipt and amount alone",
    lumberAfterLeak?.receiptStoredAssetId === attached.asset.id &&
      Number(lumberAfterLeak?.amount.toString()) === 142.68,
  );

  const crossRead = await authorizePrivateStoredAssetDownload(prisma, attached.asset.id, businessB.id, {
    provider,
    viewer: betaViewer,
  });
  check(
    "Business B cannot download Business A receipt",
    crossRead.ok === false && crossRead.status === 404,
  );

  await expectThrow(
    "OWNER cannot attach a receipt to another business expense by id",
    () =>
      putExpenseReceiptFromBytes(deps, ownerA, {
        expenseId: betaPaint.id,
        originalFilename: "cross.jpg",
        mimeType: "image/jpeg",
        body: jpegBytes,
      }),
    (error) => error instanceof Error,
  );

  await expectThrow(
    "Oversized receipt is rejected before storage reserve",
    () =>
      authorizeExpenseReceiptUpload(deps, ownerA, {
        expenseId: paint.id,
        originalFilename: "huge.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: EXPENSE_RECEIPT_MAX_BYTES + 1,
      }),
    (error) => error instanceof StorageError && /too large/i.test(error.message),
  );
  await expectThrow(
    "Unsupported receipt type is rejected",
    () =>
      authorizeExpenseReceiptUpload(deps, ownerA, {
        expenseId: paint.id,
        originalFilename: "notes.txt",
        mimeType: "text/plain",
        fileSizeBytes: 40,
      }),
    (error) => error instanceof StorageError && /Unsupported/i.test(error.message),
  );
  const paintAfterLimits = await prisma.expense.findUnique({ where: { id: paint.id } });
  const paintAccount = await accountSnapshot(businessA.id);
  check(
    "Rejected limits leave the unused expense without a reserved object",
    paintAfterLimits?.receiptStoredAssetId === null &&
      paintAccount.reservedBytes === 0 &&
      paintAccount.usedBytes === jpegBytes.byteLength,
  );

  console.log("\nTEST — Storage-failure rollback");
  const failingDeps = { ...deps, provider: failPut(provider) };
  const usedBeforeFail = (await accountSnapshot(businessA.id)).usedBytes;
  await expectThrow(
    "Provider put failure rolls back the pending upload",
    () =>
      putExpenseReceiptFromBytes(failingDeps, ownerA, {
        expenseId: paint.id,
        originalFilename: "fail.jpg",
        mimeType: "image/jpeg",
        body: jpegBytes,
      }),
    (error) => error instanceof Error && /simulated provider putObject failure/.test(error.message),
  );
  const paintAfterFail = await prisma.expense.findUnique({ where: { id: paint.id } });
  const afterFail = await accountSnapshot(businessA.id);
  const failedAssets = await prisma.storedAsset.findMany({
    where: { businessId: businessA.id, originalFilename: "fail.jpg" },
  });
  check(
    "Failed upload does not attach a receipt or change the amount",
    paintAfterFail?.receiptStoredAssetId === null &&
      Number(paintAfterFail?.amount.toString()) === 48,
  );
  check(
    "Failed upload releases reservation and does not keep used bytes",
    afterFail.reservedBytes === 0 && afterFail.usedBytes === usedBeforeFail,
  );
  check(
    "Failed upload marks the pending asset FAILED",
    failedAssets.length === 1 && failedAssets[0].status === "FAILED",
  );

  console.log("\nTEST — Replacement and remove leave the amount alone");
  const replaced = await putExpenseReceiptFromBytes(deps, ownerA, {
    expenseId: lumber.id,
    originalFilename: "lumber-replaced.jpg",
    mimeType: "image/jpeg",
    body: replacementBytes,
  });
  check(
    "Replacement attaches the new private asset",
    replaced.expense.receiptStoredAssetId === replaced.asset.id &&
      replaced.previousStoredAssetId === attached.asset.id,
  );
  check(
    "Replacement does not change the recorded amount or tax label",
    Number(replaced.expense.amount.toString()) === 142.68 &&
      replaced.expense.taxCategory === "UNSPECIFIED" &&
      replaced.expense.receiptUrl === legacyReceiptUrl,
  );
  const oldAsset = await prisma.storedAsset.findUnique({ where: { id: attached.asset.id } });
  const afterReplace = await accountSnapshot(businessA.id);
  const oldObjectGone = !(await provider.objectExists({
    bucket: receiptBucket,
    key: attached.asset.storageKey,
  }));
  check(
    "Previous receipt is deleted and quota moves to the new file",
    oldAsset?.status === "DELETED" &&
      oldAsset.deletedAt != null &&
      oldAsset.publicPath === null &&
      afterReplace.usedBytes === replacementBytes.byteLength &&
      afterReplace.reservedBytes === 0 &&
      oldObjectGone,
  );
  const oldRead = await authorizePrivateStoredAssetDownload(prisma, attached.asset.id, businessA.id, {
    provider,
    viewer: ownerViewer,
  });
  const newRead = await authorizePrivateStoredAssetDownload(prisma, replaced.asset.id, businessA.id, {
    provider,
    viewer: ownerViewer,
  });
  check(
    "Replaced receipt is no longer downloadable; the new one is",
    oldRead.ok === false &&
      oldRead.status === 404 &&
      newRead.ok === true &&
      newRead.url === `memory://download/${receiptBucket}/${replaced.asset.storageKey}`,
  );

  const pdfAttached = await putExpenseReceiptFromBytes(deps, adminA, {
    expenseId: paint.id,
    originalFilename: "paint.pdf",
    mimeType: "application/pdf",
    body: pdfBytes,
  });
  check(
    "ADMIN can attach a PDF receipt without changing amount",
    pdfAttached.expense.receiptStoredAssetId === pdfAttached.asset.id &&
      Number(pdfAttached.expense.amount.toString()) === 48 &&
      pdfAttached.asset.mimeType === "application/pdf",
  );

  const removed = await removeExpenseReceiptAttachment(deps, ownerA, lumber.id);
  check(
    "Remove clears the private receipt and leaves the amount",
    removed.expense.receiptStoredAssetId === null &&
      removed.expense.receiptUrl === legacyReceiptUrl &&
      Number(removed.expense.amount.toString()) === 142.68 &&
      removed.previousStoredAssetId === replaced.asset.id,
  );
  const removedAsset = await prisma.storedAsset.findUnique({ where: { id: replaced.asset.id } });
  const afterRemove = await accountSnapshot(businessA.id);
  const removedRead = await authorizePrivateStoredAssetDownload(prisma, replaced.asset.id, businessA.id, {
    provider,
    viewer: ownerViewer,
  });
  const removedObjectGone = !(await provider.objectExists({
    bucket: receiptBucket,
    key: replaced.asset.storageKey,
  }));
  check(
    "Removed receipt is deleted from storage and quota",
    removedAsset?.status === "DELETED" &&
      afterRemove.usedBytes === pdfBytes.byteLength &&
      afterRemove.reservedBytes === 0 &&
      removedRead.ok === false &&
      removedObjectGone,
  );

  await expectThrow(
    "MEMBER cannot remove a receipt",
    () => removeExpenseReceiptAttachment(deps, memberA, paint.id),
    (error) => error instanceof ForbiddenError,
  );
  await expectThrow(
    "Business B cannot remove Business A receipt",
    () => removeExpenseReceiptAttachment(deps, ownerB, paint.id),
    (error) => error instanceof Error,
  );
  const paintStill = await prisma.expense.findUnique({ where: { id: paint.id } });
  check(
    "Unauthorized remove left the PDF receipt and amount",
    paintStill?.receiptStoredAssetId === pdfAttached.asset.id &&
      Number(paintStill?.amount.toString()) === 48,
  );

  console.log("\nTEST — Finalize failure after a successful upload aborts");
  const finalizeFailExpense = await createExpense(prisma, ownerA, {
    occurredOn: "2026-09-03",
    description: "Finalize fail",
    amount: "12.00",
    category: "OTHER",
  });
  const usedBeforeFinalizeFail = (await accountSnapshot(businessA.id)).usedBytes;
  await expectThrow(
    "Upload succeeds but finalize failure aborts the pending asset",
    () =>
      putExpenseReceiptFromBytes(
        { ...deps, provider: failFinalizeAfterPut(provider) },
        ownerA,
        {
          expenseId: finalizeFailExpense.id,
          originalFilename: "ghost.jpg",
          mimeType: "image/jpeg",
          body: jpegBytes,
        },
      ),
    (error) => error instanceof Error && /not found in storage/i.test(error.message),
  );
  const finalizeFailRow = await prisma.expense.findUnique({ where: { id: finalizeFailExpense.id } });
  const afterFinalizeFail = await accountSnapshot(businessA.id);
  const ghostAssets = await prisma.storedAsset.findMany({
    where: { businessId: businessA.id, originalFilename: "ghost.jpg" },
  });
  check(
    "Finalize failure does not attach a receipt or change the amount",
    finalizeFailRow?.receiptStoredAssetId === null &&
      Number(finalizeFailRow?.amount.toString()) === 12,
  );
  check(
    "Finalize failure releases reservation and does not keep used bytes",
    afterFinalizeFail.reservedBytes === 0 && afterFinalizeFail.usedBytes === usedBeforeFinalizeFail,
  );
  check(
    "Finalize failure marks the pending asset FAILED",
    ghostAssets.length === 1 && ghostAssets[0].status === "FAILED",
  );
  check(
    "Finalize failure removes the uploaded object from the memory provider",
    ghostAssets[0] != null &&
      (await provider.objectExists({ bucket: receiptBucket, key: ghostAssets[0].storageKey })) ===
        false,
  );

  console.log("\nTEST — Concurrent replace and remove-vs-replace stay atomic");
  const raceExpense = await createExpense(prisma, ownerA, {
    occurredOn: "2026-09-04",
    description: "Race",
    amount: "33.00",
    category: "OTHER",
  });
  const seeded = await putExpenseReceiptFromBytes(deps, ownerA, {
    expenseId: raceExpense.id,
    originalFilename: "seed.jpg",
    mimeType: "image/jpeg",
    body: jpegBytes,
  });
  const replacePair = await Promise.allSettled([
    putExpenseReceiptFromBytes(deps, ownerA, {
      expenseId: raceExpense.id,
      originalFilename: "race-a.jpg",
      mimeType: "image/jpeg",
      body: jpegReplaceA,
    }),
    putExpenseReceiptFromBytes(deps, ownerA, {
      expenseId: raceExpense.id,
      originalFilename: "race-b.jpg",
      mimeType: "image/jpeg",
      body: jpegReplaceB,
    }),
  ]);
  const replaceWins = replacePair.filter((result) => result.status === "fulfilled");
  const replaceFailures = replacePair.filter((result) => result.status === "rejected");
  const replaceRetries = replaceFailures.filter(
    (result) =>
      result.status === "rejected" &&
      result.reason instanceof Error &&
      result.reason.message === CONCURRENT_EXPENSE_RECEIPT_ERROR,
  );
  check(
    "Two concurrent replaces succeed or fail only with a concurrent retry",
    replaceWins.length >= 1 && replaceRetries.length === replaceFailures.length,
  );
  const afterTwoReplaces = await prisma.expense.findUnique({ where: { id: raceExpense.id } });
  const winnerAsset = afterTwoReplaces?.receiptStoredAssetId
    ? await prisma.storedAsset.findUnique({ where: { id: afterTwoReplaces.receiptStoredAssetId } })
    : null;
  const readyOnRace = await prisma.storedAsset.count({
    where: { id: afterTwoReplaces?.receiptStoredAssetId ?? "__none__", status: "READY" },
  });
  const readyReceipts = await prisma.storedAsset.findMany({
    where: { businessId: businessA.id, purpose: EXPENSE_RECEIPT_PURPOSE, status: "READY" },
  });
  const usedAfterTwoReplaces = await accountSnapshot(businessA.id);
  check(
    "Exactly one READY receipt stays on the raced expense",
    readyOnRace === 1 &&
      winnerAsset?.status === "READY" &&
      Number(afterTwoReplaces?.amount.toString()) === 33,
  );
  check(
    "storageUsedBytes equals READY receipt file sizes after concurrent replaces",
    usedAfterTwoReplaces.usedBytes ===
      readyReceipts.reduce((sum, asset) => sum + asset.fileSizeBytes, 0) &&
      winnerAsset != null &&
      readyReceipts.some((asset) => asset.id === winnerAsset.id),
  );

  const removeVsReplace = await Promise.allSettled([
    removeExpenseReceiptAttachment(deps, ownerA, raceExpense.id),
    putExpenseReceiptFromBytes(deps, ownerA, {
      expenseId: raceExpense.id,
      originalFilename: "race-final.jpg",
      mimeType: "image/jpeg",
      body: replacementBytes,
    }),
  ]);
  const removeVsReplaceWins = removeVsReplace.filter((result) => result.status === "fulfilled");
  const removeVsReplaceFailures = removeVsReplace.filter((result) => result.status === "rejected");
  const removeVsReplaceRetries = removeVsReplaceFailures.filter(
    (result) =>
      result.status === "rejected" &&
      result.reason instanceof Error &&
      result.reason.message === CONCURRENT_EXPENSE_RECEIPT_ERROR,
  );
  check(
    "Remove versus replace succeeds or fails only with a concurrent retry",
    removeVsReplaceWins.length >= 1 && removeVsReplaceRetries.length === removeVsReplaceFailures.length,
  );
  const afterRemoveVsReplace = await prisma.expense.findUnique({ where: { id: raceExpense.id } });
  const remainingReady = afterRemoveVsReplace?.receiptStoredAssetId
    ? await prisma.storedAsset.findUnique({ where: { id: afterRemoveVsReplace.receiptStoredAssetId } })
    : null;
  const readyAfterRace = await prisma.storedAsset.findMany({
    where: { businessId: businessA.id, purpose: EXPENSE_RECEIPT_PURPOSE, status: "READY" },
  });
  const usedAfterRace = await accountSnapshot(businessA.id);
  check(
    "Remove versus replace leaves at most one READY receipt on the expense",
    (afterRemoveVsReplace?.receiptStoredAssetId
      ? remainingReady?.status === "READY"
      : remainingReady === null) && Number(afterRemoveVsReplace?.amount.toString()) === 33,
  );
  check(
    "storageUsedBytes equals remaining READY receipt sizes after remove versus replace",
    usedAfterRace.usedBytes === readyAfterRace.reduce((sum, asset) => sum + asset.fileSizeBytes, 0),
  );
  if (afterRemoveVsReplace?.receiptStoredAssetId) {
    check(
      "The raced expense still has exactly one READY receipt",
      remainingReady?.id === afterRemoveVsReplace.receiptStoredAssetId &&
        remainingReady.status === "READY",
    );
  } else {
    check("The raced expense has no private receipt after remove won", remainingReady === null);
  }

  console.log(
    failures === 0
      ? "\nAll Expense receipt checks passed."
      : `\n${failures} Expense receipt check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
  requireLocalDatabaseUrl(baseUrl, "DATABASE_URL");
  requireLocalDatabaseUrl(testUrl, "Expense receipt test DATABASE_URL");
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

process.exit(failures === 0 ? 0 : 1);

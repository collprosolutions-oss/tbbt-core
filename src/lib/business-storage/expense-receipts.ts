/**
 * Private managed expense receipts.
 *
 * OWNER attaches a bounded file to a same-business expense, reviews
 * it through the authorized private download route, and replaces or
 * removes it without changing the recorded amount or inferring tax
 * treatment. ADMIN may view and download the same-business receipt
 * but cannot attach, replace, or remove it. Bytes stay in managed
 * object storage. The UI never receives a public file URL.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  attachExpenseReceipt,
  ExpenseError,
  removeExpenseReceipt,
  type ExpenseReceiptClaimAfter,
} from "@/lib/expense-ops";
import { requireSaasOperatingEntitlement } from "@/lib/saas-billing/entitlement";
import { privateAssetPath } from "@/lib/business-storage/keys";
import {
  abortManagedUpload,
  authorizeManagedUpload,
  bestEffortCleanupOwnedObject,
  finalizeManagedUpload,
  resolveStorageProvider,
  type StorageServiceDeps,
} from "@/lib/business-storage/service";
import {
  StorageAccessError,
  StorageError,
} from "@/lib/business-storage/types";

export const EXPENSE_RECEIPT_PURPOSE = "EXPENSE_RECEIPT";
export const EXPENSE_RECEIPT_CATEGORY = "ATTACHMENT" as const;
/**
 * Direct server-action upload stays under the Vercel Function body cap
 * (~4.5 MB) so a rejected file is always our validation error.
 */
export const EXPENSE_RECEIPT_MAX_BYTES = 4 * 1024 * 1024;

const RECEIPT_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

type Db = PrismaClient | Prisma.TransactionClient;

export function expenseReceiptMaxBytesLabel() {
  const mb = EXPENSE_RECEIPT_MAX_BYTES / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
}

export function isExpenseReceiptMimeType(value: string) {
  return RECEIPT_MIME_TYPES.has(value.trim().toLowerCase());
}

function asciiAt(bytes: Uint8Array, start: number, length: number) {
  if (start + length > bytes.length) return "";
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function detectHeifBrand(bytes: Uint8Array) {
  if (bytes.length < 12 || asciiAt(bytes, 4, 4) !== "ftyp") return null;
  const brands = [asciiAt(bytes, 8, 4)];
  for (let offset = 16; offset + 4 <= Math.min(bytes.length, 64); offset += 4) {
    brands.push(asciiAt(bytes, offset, 4));
  }
  if (brands.some((brand) => brand === "heic" || brand === "heix")) return "image/heic";
  if (brands.some((brand) => brand === "mif1" || brand === "msf1")) return "image/heif";
  return null;
}

export function detectExpenseReceiptMimeType(body: Buffer | Uint8Array) {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 4 && asciiAt(bytes, 0, 4) === "GIF8") {
    return "image/gif";
  }
  if (bytes.length >= 12 && asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 5 && asciiAt(bytes, 0, 5) === "%PDF-") {
    return "application/pdf";
  }
  return detectHeifBrand(bytes);
}

export function resolveExpenseReceiptMimeType(file: {
  type?: string | null;
  name?: string | null;
}) {
  const type = (file.type || "").trim().toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  if (RECEIPT_MIME_TYPES.has(type)) return type;
  const name = (file.name || "").trim().toLowerCase();
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".heic")) return "image/heic";
  if (name.endsWith(".heif")) return "image/heif";
  if (name.endsWith(".pdf")) return "application/pdf";
  return null;
}

export function inspectExpenseReceiptUpload(file: {
  type?: string | null;
  name?: string | null;
  size: number;
  body?: Buffer | Uint8Array;
}) {
  if (file.size <= 0 || file.size > EXPENSE_RECEIPT_MAX_BYTES) {
    return {
      ok: false as const,
      error: `That receipt is too large. The limit is ${expenseReceiptMaxBytesLabel()}.`,
    };
  }
  const declared = resolveExpenseReceiptMimeType(file);
  if (file.body) {
    if (file.body.byteLength !== file.size) {
      return {
        ok: false as const,
        error: "That receipt file does not match the declared size.",
      };
    }
    const detected = detectExpenseReceiptMimeType(file.body);
    if (!detected) {
      return {
        ok: false as const,
        error: "Unsupported receipt type. Upload a JPEG, PNG, WebP, GIF, HEIC, or PDF file.",
      };
    }
    if (declared && declared !== detected) {
      return {
        ok: false as const,
        error: "That file does not match the declared receipt type.",
      };
    }
    return {
      ok: true as const,
      mimeType: detected,
      fileName: (file.name || "").trim() || (detected === "application/pdf" ? "receipt.pdf" : "receipt"),
      fileSizeBytes: file.size,
    };
  }
  if (!declared) {
    return {
      ok: false as const,
      error: "Unsupported receipt type. Upload a JPEG, PNG, WebP, GIF, HEIC, or PDF file.",
    };
  }
  return {
    ok: true as const,
    mimeType: declared,
    fileName: (file.name || "").trim() || (declared === "application/pdf" ? "receipt.pdf" : "receipt"),
    fileSizeBytes: file.size,
  };
}

export function expenseReceiptHref(storedAssetId?: string | null) {
  const id = storedAssetId?.trim();
  return id ? privateAssetPath(id) : null;
}

async function requireReceiptMutation(db: Db, access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_EXPENSE_RECEIPTS);
  await requireSaasOperatingEntitlement(db, access);
}

async function loadOwnedActiveExpense(db: Db, access: BusinessAccess, expenseId: string) {
  const expense = access.assertOwned(
    await db.expense.findFirst({
      where: { id: expenseId, ...access.scope },
    }),
  );
  if (expense.voidedAt) {
    throw new ExpenseError("This expense has been voided.");
  }
  return expense;
}

export async function authorizeExpenseReceiptUpload(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  input: {
    expenseId: string;
    originalFilename: string;
    mimeType: string;
    fileSizeBytes: number;
    body?: Buffer | Uint8Array;
  },
) {
  await requireReceiptMutation(deps.db, access);
  const expense = await loadOwnedActiveExpense(deps.db, access, input.expenseId);
  const inspection = inspectExpenseReceiptUpload({
    type: input.mimeType,
    name: input.originalFilename,
    size: input.fileSizeBytes,
    body: input.body,
  });
  if (!inspection.ok) {
    throw new StorageError(inspection.error);
  }

  return authorizeManagedUpload(deps, access.businessId, {
    category: EXPENSE_RECEIPT_CATEGORY,
    purpose: EXPENSE_RECEIPT_PURPOSE,
    originalFilename: inspection.fileName,
    mimeType: inspection.mimeType,
    fileSizeBytes: inspection.fileSizeBytes,
    visibility: "PRIVATE",
    jobId: expense.jobId,
    customerId: expense.customerId,
  });
}

export async function abortExpenseReceiptUpload(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  assetId: string,
) {
  await requireReceiptMutation(deps.db, access);
  const pending = await deps.db.storedAsset.findFirst({
    where: {
      id: assetId,
      businessId: access.businessId,
      purpose: EXPENSE_RECEIPT_PURPOSE,
    },
    select: { id: true },
  });
  if (!pending) {
    throw new StorageAccessError();
  }
  return abortManagedUpload(deps, access.businessId, pending.id);
}

async function claimUnreferencedExpenseReceiptInTx(
  tx: Db,
  access: BusinessAccess,
  assetId: string,
  now: Date,
) {
  const referenced = await tx.expense.findFirst({
    where: { receiptStoredAssetId: assetId, businessId: access.businessId },
    select: { id: true },
  });
  if (referenced) return null;
  const asset = await tx.storedAsset.findFirst({
    where: {
      id: assetId,
      businessId: access.businessId,
      purpose: EXPENSE_RECEIPT_PURPOSE,
    },
    include: { storageAccount: true },
  });
  if (!asset || asset.status !== "READY") return null;
  const updated = await tx.storedAsset.updateMany({
    where: {
      id: asset.id,
      businessId: access.businessId,
      purpose: EXPENSE_RECEIPT_PURPOSE,
      status: "READY",
    },
    data: { status: "DELETED", deletedAt: now, publicPath: null },
  });
  if (updated.count !== 1) return null;
  if (asset.fileSizeBytes > 0) {
    await tx.businessStorageAccount.update({
      where: { id: asset.storageAccountId },
      data: { storageUsedBytes: { decrement: asset.fileSizeBytes } },
    });
  }
  return {
    bucket: asset.storageAccount.bucketName,
    storageKey: asset.storageKey,
  };
}

function releasePreviousReceiptAfterClaim(
  access: BusinessAccess,
  now: Date,
  sink: { object: { bucket: string; storageKey: string } | null },
): ExpenseReceiptClaimAfter {
  return async (tx, { previousStoredAssetId, nextStoredAssetId }) => {
    if (!previousStoredAssetId || previousStoredAssetId === nextStoredAssetId) return;
    sink.object = await claimUnreferencedExpenseReceiptInTx(tx, access, previousStoredAssetId, now);
  };
}

export async function releaseUnreferencedExpenseReceiptAsset(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  assetId: string,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_EXPENSE_RECEIPTS);
  const id = assetId.trim();
  if (!id) return { released: false as const, reason: "missing", assetId: undefined };
  const asset = await deps.db.storedAsset.findFirst({
    where: { id, ...access.scope },
    include: { storageAccount: true },
  });
  if (!asset || asset.businessId !== access.businessId) {
    throw new StorageAccessError();
  }
  if (asset.purpose !== EXPENSE_RECEIPT_PURPOSE) {
    throw new StorageError("Only an unreferenced expense receipt can be cleaned up here.");
  }
  if (asset.status === "DELETED" || asset.deletedAt) {
    return { released: false as const, reason: "already_deleted", assetId: asset.id };
  }
  const now = deps.now?.() ?? new Date();
  if (asset.status === "PENDING") {
    const referenced = await deps.db.expense.findFirst({
      where: { receiptStoredAssetId: asset.id, businessId: access.businessId },
      select: { id: true },
    });
    if (referenced) {
      return { released: false as const, reason: "referenced", assetId: asset.id };
    }
    await abortManagedUpload(deps, access.businessId, asset.id);
    return { released: true as const, reason: "aborted", assetId: asset.id };
  }
  const claimed = await deps.db.$transaction(async (tx) => {
    return claimUnreferencedExpenseReceiptInTx(tx, access, asset.id, now);
  });
  if (claimed) {
    await bestEffortCleanupOwnedObject(deps, access.businessId, claimed);
    return { released: true as const, reason: "deleted", assetId: asset.id };
  }
  return { released: false as const, reason: "already_deleted", assetId: asset.id };
}

async function assertPrivateExpenseReceiptAsset(
  asset: {
    visibility: string;
    publicPath: string | null;
    category: string;
    purpose: string | null;
    status: string;
  },
) {
  if (
    asset.visibility !== "PRIVATE" ||
    asset.publicPath ||
    asset.category !== EXPENSE_RECEIPT_CATEGORY ||
    asset.purpose !== EXPENSE_RECEIPT_PURPOSE ||
    asset.status !== "READY"
  ) {
    throw new StorageError("That file is not a private expense receipt.");
  }
}

export async function finalizeAndAttachExpenseReceipt(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  input: { expenseId: string; assetId: string },
) {
  await requireReceiptMutation(deps.db, access);
  await loadOwnedActiveExpense(deps.db, access, input.expenseId);
  const asset = await finalizeManagedUpload(deps, access.businessId, input.assetId);
  try {
    await assertPrivateExpenseReceiptAsset(asset);
    const releasedObject = { object: null as { bucket: string; storageKey: string } | null };
    const attached = await attachExpenseReceipt(
      deps.db,
      access,
      {
        expenseId: input.expenseId,
        storedAssetId: asset.id,
      },
      releasePreviousReceiptAfterClaim(access, deps.now?.() ?? new Date(), releasedObject),
    );
    if (releasedObject.object) {
      await bestEffortCleanupOwnedObject(deps, access.businessId, releasedObject.object);
    }
    return { expense: attached.expense, asset, previousStoredAssetId: attached.previousStoredAssetId };
  } catch (error) {
    await releaseUnreferencedExpenseReceiptAsset(deps, access, asset.id).catch((releaseError) => {
      console.error("Failed to release unreferenced expense receipt after attach failure", {
        assetId: asset.id,
        error: releaseError,
      });
    });
    throw error;
  }
}

export async function putExpenseReceiptFromBytes(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  input: {
    expenseId: string;
    originalFilename: string;
    mimeType: string;
    body: Buffer | Uint8Array;
  },
) {
  const inspection = inspectExpenseReceiptUpload({
    type: input.mimeType,
    name: input.originalFilename,
    size: input.body.byteLength,
    body: input.body,
  });
  if (!inspection.ok) {
    throw new StorageError(inspection.error);
  }
  const authorized = await authorizeExpenseReceiptUpload(deps, access, {
    expenseId: input.expenseId,
    originalFilename: inspection.fileName,
    mimeType: inspection.mimeType,
    fileSizeBytes: inspection.fileSizeBytes,
    body: input.body,
  });
  const provider = await resolveStorageProvider(deps);
  try {
    await provider.putObject({
      bucket: authorized.account.bucketName,
      key: authorized.asset.storageKey,
      body: input.body,
      contentType: authorized.asset.mimeType,
    });
    return await finalizeAndAttachExpenseReceipt(deps, access, {
      expenseId: input.expenseId,
      assetId: authorized.asset.id,
    });
  } catch (error) {
    await abortExpenseReceiptUpload(deps, access, authorized.asset.id).catch(() => undefined);
    throw error;
  }
}

export async function removeExpenseReceiptAttachment(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  expenseId: string,
) {
  const releasedObject = { object: null as { bucket: string; storageKey: string } | null };
  const removed = await removeExpenseReceipt(
    deps.db,
    access,
    { expenseId },
    releasePreviousReceiptAfterClaim(access, deps.now?.() ?? new Date(), releasedObject),
  );
  if (releasedObject.object) {
    await bestEffortCleanupOwnedObject(deps, access.businessId, releasedObject.object);
  }
  return removed;
}

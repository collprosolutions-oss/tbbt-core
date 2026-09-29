/**
 * Private managed expense receipts.
 *
 * OWNER/ADMIN attach a bounded file to a same-business expense, review
 * it through the authorized private download route, and replace or
 * remove it without changing the recorded amount or inferring tax
 * treatment. Bytes stay in managed object storage. The UI never receives
 * a public file URL.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  attachExpenseReceipt,
  ExpenseError,
  removeExpenseReceipt,
} from "@/lib/expense-ops";
import { requireSaasOperatingEntitlement } from "@/lib/saas-billing/entitlement";
import { privateAssetPath } from "@/lib/business-storage/keys";
import {
  abortManagedUpload,
  finalizeManagedUpload,
  authorizeManagedUpload,
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
}) {
  const mimeType = resolveExpenseReceiptMimeType(file);
  if (!mimeType) {
    return {
      ok: false as const,
      error: "Unsupported receipt type. Upload a JPEG, PNG, WebP, GIF, HEIC, or PDF file.",
    };
  }
  if (file.size <= 0 || file.size > EXPENSE_RECEIPT_MAX_BYTES) {
    return {
      ok: false as const,
      error: `That receipt is too large. The limit is ${expenseReceiptMaxBytesLabel()}.`,
    };
  }
  return {
    ok: true as const,
    mimeType,
    fileName: (file.name || "").trim() || (mimeType === "application/pdf" ? "receipt.pdf" : "receipt"),
    fileSizeBytes: file.size,
  };
}

export function expenseReceiptHref(storedAssetId?: string | null) {
  const id = storedAssetId?.trim();
  return id ? privateAssetPath(id) : null;
}

async function requireReceiptMutation(db: Db, access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_EXPENSES);
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
  },
) {
  await requireReceiptMutation(deps.db, access);
  const expense = await loadOwnedActiveExpense(deps.db, access, input.expenseId);
  const inspection = inspectExpenseReceiptUpload({
    type: input.mimeType,
    name: input.originalFilename,
    size: input.fileSizeBytes,
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

export async function releaseUnreferencedExpenseReceiptAsset(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  assetId: string,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_EXPENSES);
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
  const referenced = await deps.db.expense.findFirst({
    where: { receiptStoredAssetId: asset.id, businessId: access.businessId },
    select: { id: true },
  });
  if (referenced) {
    return { released: false as const, reason: "referenced", assetId: asset.id };
  }
  const now = deps.now?.() ?? new Date();
  if (asset.status === "PENDING") {
    await abortManagedUpload(deps, access.businessId, asset.id);
    return { released: true as const, reason: "aborted", assetId: asset.id };
  }
  try {
    const provider = await resolveStorageProvider(deps);
    await provider.deleteObject({
      bucket: asset.storageAccount.bucketName,
      key: asset.storageKey,
    }).catch(() => undefined);
  } catch {
    // Provider absence still allows the tenant-scoped DB cleanup below.
  }
  await deps.db.$transaction(async (tx) => {
    await tx.storedAsset.update({
      where: { id: asset.id },
      data: { status: "DELETED", deletedAt: now, publicPath: null },
    });
    if (asset.status === "READY" && asset.fileSizeBytes > 0) {
      await tx.businessStorageAccount.update({
        where: { id: asset.storageAccountId },
        data: { storageUsedBytes: { decrement: asset.fileSizeBytes } },
      });
    }
  });
  return { released: true as const, reason: "deleted", assetId: asset.id };
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
    const attached = await attachExpenseReceipt(deps.db, access, {
      expenseId: input.expenseId,
      storedAssetId: asset.id,
    });
    if (attached.previousStoredAssetId && attached.previousStoredAssetId !== asset.id) {
      await releaseUnreferencedExpenseReceiptAsset(deps, access, attached.previousStoredAssetId);
    }
    return { expense: attached.expense, asset, previousStoredAssetId: attached.previousStoredAssetId };
  } catch (error) {
    await releaseUnreferencedExpenseReceiptAsset(deps, access, asset.id).catch(() => undefined);
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
  const authorized = await authorizeExpenseReceiptUpload(deps, access, {
    expenseId: input.expenseId,
    originalFilename: input.originalFilename,
    mimeType: input.mimeType,
    fileSizeBytes: input.body.byteLength,
  });
  const provider = await resolveStorageProvider(deps);
  try {
    await provider.putObject({
      bucket: authorized.account.bucketName,
      key: authorized.asset.storageKey,
      body: input.body,
      contentType: authorized.asset.mimeType,
    });
    return finalizeAndAttachExpenseReceipt(deps, access, {
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
  const removed = await removeExpenseReceipt(deps.db, access, { expenseId });
  if (removed.previousStoredAssetId) {
    await releaseUnreferencedExpenseReceiptAsset(deps, access, removed.previousStoredAssetId);
  }
  return removed;
}

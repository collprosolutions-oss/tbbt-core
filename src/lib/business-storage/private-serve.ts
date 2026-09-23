import type { MembershipRole, Prisma, PrismaClient } from "@prisma/client";
import { canAccessManagementConsole } from "@/lib/authorization";
import {
  resolveStorageProvider,
  type StorageServiceDeps,
} from "@/lib/business-storage/service";
import { PRIVATE_DOWNLOAD_URL_TTL_SECONDS } from "@/lib/business-storage/types";

type Db = PrismaClient | Prisma.TransactionClient;

export type PrivateAssetViewer = {
  role: MembershipRole;
  membershipId: string;
};

export type PrivateStoredAssetServeResult =
  | {
      ok: true;
      status: 200;
      body: Uint8Array;
      contentType: string;
      contentLength: number;
      contentDisposition: string;
    }
  | {
      ok: false;
      status: 401 | 404 | 502 | 503;
      body: string;
    };

export type PrivateStoredAssetDownloadResult =
  | {
      ok: true;
      status: 302;
      url: string;
      expiresInSeconds: number;
    }
  | {
      ok: false;
      status: 401 | 404 | 502 | 503;
      body: string;
    };

const PREVIEWABLE_PRIVATE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function headerFilename(name: string) {
  const cleaned = name.replace(/[\r\n"]/g, "").trim() || "photo";
  return cleaned.slice(0, 120);
}

export function privateAssetContentDisposition(input: {
  mimeType?: string | null;
  originalFilename?: string | null;
}) {
  const filename = headerFilename(input.originalFilename ?? "photo");
  const mime = (input.mimeType ?? "").trim().toLowerCase();
  const disposition = PREVIEWABLE_PRIVATE_IMAGE_TYPES.has(mime)
    ? "inline"
    : "attachment";
  return `${disposition}; filename="${filename}"`;
}

type AuthorizedPrivateAsset = {
  ok: true;
  asset: {
    id: string;
    originalFilename: string;
    mimeType: string;
    storageKey: string;
    storageAccount: { bucketName: string };
  };
};

async function authorizePrivateStoredAsset(
  db: Db,
  assetId: string,
  businessId: string,
  viewer?: PrivateAssetViewer,
): Promise<AuthorizedPrivateAsset | Extract<PrivateStoredAssetServeResult, { ok: false }>> {
  const id = assetId.trim();
  if (!id || !businessId.trim()) {
    return { ok: false, status: 404, body: "Not found" };
  }

  const asset = await db.storedAsset.findFirst({
    where: {
      id,
      businessId,
      status: "READY",
      deletedAt: null,
    },
    include: { storageAccount: true },
  });
  if (!asset) {
    return { ok: false, status: 404, body: "Not found" };
  }

  if (viewer && !canAccessManagementConsole(viewer.role)) {
    const allowed = await memberCanReadAssignedJobPhoto(db, {
      businessId,
      membershipId: viewer.membershipId,
      asset,
    });
    if (!allowed) {
      return { ok: false, status: 404, body: "Not found" };
    }
  }

  return { ok: true, asset };
}

/**
 * Authorize a private asset, then return a short-lived presigned GET URL.
 * The object bytes are never loaded into the server process.
 */
export async function authorizePrivateStoredAssetDownload(
  db: Db,
  assetId: string,
  businessId: string,
  deps?: Pick<StorageServiceDeps, "provider"> & { viewer?: PrivateAssetViewer },
): Promise<PrivateStoredAssetDownloadResult> {
  const authorized = await authorizePrivateStoredAsset(
    db,
    assetId,
    businessId,
    deps?.viewer,
  );
  if (!authorized.ok) return authorized;

  let provider;
  try {
    provider = await resolveStorageProvider(deps);
  } catch {
    return { ok: false, status: 503, body: "Storage is not configured" };
  }

  try {
    const meta = await provider.getObjectMetadata({
      bucket: authorized.asset.storageAccount.bucketName,
      key: authorized.asset.storageKey,
    });
    if (!meta || meta.sizeBytes <= 0) {
      return { ok: false, status: 404, body: "Not found" };
    }
    const download = await provider.createDownloadUrl({
      bucket: authorized.asset.storageAccount.bucketName,
      key: authorized.asset.storageKey,
      expiresInSeconds: PRIVATE_DOWNLOAD_URL_TTL_SECONDS,
    });
    return {
      ok: true,
      status: 302,
      url: download.url,
      expiresInSeconds: download.expiresInSeconds,
    };
  } catch {
    return { ok: false, status: 502, body: "Storage read failed" };
  }
}

/**
 * In-process private-asset byte read for tests and non-HTTP callers.
 * Authenticated browser delivery must use authorizePrivateStoredAssetDownload
 * so large photos never pass through a Vercel Function body.
 */
export async function servePrivateStoredAsset(
  db: Db,
  assetId: string,
  businessId: string,
  deps?: Pick<StorageServiceDeps, "provider"> & { viewer?: PrivateAssetViewer },
): Promise<PrivateStoredAssetServeResult> {
  const authorized = await authorizePrivateStoredAsset(
    db,
    assetId,
    businessId,
    deps?.viewer,
  );
  if (!authorized.ok) return authorized;

  let provider;
  try {
    provider = await resolveStorageProvider(deps);
  } catch {
    return { ok: false, status: 503, body: "Storage is not configured" };
  }

  try {
    const object = await provider.getObject({
      bucket: authorized.asset.storageAccount.bucketName,
      key: authorized.asset.storageKey,
    });
    if (!object || object.body.byteLength <= 0) {
      return { ok: false, status: 404, body: "Not found" };
    }
    const body =
      object.body instanceof Uint8Array
        ? object.body
        : new Uint8Array(object.body);
    const contentType = object.contentType || authorized.asset.mimeType || "application/octet-stream";
    return {
      ok: true,
      status: 200,
      body,
      contentType,
      contentLength: body.byteLength,
      contentDisposition: privateAssetContentDisposition({
        mimeType: contentType,
        originalFilename: authorized.asset.originalFilename,
      }),
    };
  } catch {
    return { ok: false, status: 502, body: "Storage read failed" };
  }
}

async function memberCanReadAssignedJobPhoto(
  db: Db,
  input: {
    businessId: string;
    membershipId: string;
    asset: { category: string; jobId: string | null };
  },
) {
  if (
    input.asset.category !== "JOB_PHOTO" ||
    !input.asset.jobId ||
    !input.membershipId.trim()
  ) {
    return false;
  }
  const job = await db.job.findFirst({
    where: {
      id: input.asset.jobId,
      businessId: input.businessId,
      assignedMembershipId: input.membershipId,
    },
    select: { id: true },
  });
  return Boolean(job);
}

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  resolveStorageProvider,
  type StorageServiceDeps,
} from "@/lib/business-storage/service";

type Db = PrismaClient | Prisma.TransactionClient;

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

/**
 * Authenticated owner/admin delivery of PRIVATE (or any READY) assets
 * that belong to the workspace. Never used for unauthenticated public
 * website photos.
 */
export async function servePrivateStoredAsset(
  db: Db,
  assetId: string,
  businessId: string,
  deps?: Pick<StorageServiceDeps, "provider">,
): Promise<PrivateStoredAssetServeResult> {
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

  let provider;
  try {
    provider = await resolveStorageProvider(deps);
  } catch {
    return { ok: false, status: 503, body: "Storage is not configured" };
  }

  try {
    const object = await provider.getObject({
      bucket: asset.storageAccount.bucketName,
      key: asset.storageKey,
    });
    if (!object || object.body.byteLength <= 0) {
      return { ok: false, status: 404, body: "Not found" };
    }
    const body =
      object.body instanceof Uint8Array
        ? object.body
        : new Uint8Array(object.body);
    const contentType = object.contentType || asset.mimeType || "application/octet-stream";
    return {
      ok: true,
      status: 200,
      body,
      contentType,
      contentLength: body.byteLength,
      contentDisposition: privateAssetContentDisposition({
        mimeType: contentType,
        originalFilename: asset.originalFilename,
      }),
    };
  } catch {
    return { ok: false, status: 502, body: "Storage read failed" };
  }
}

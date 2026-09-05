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
    }
  | {
      ok: false;
      status: 401 | 404 | 502 | 503;
      body: string;
    };

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
    return {
      ok: true,
      status: 200,
      body,
      contentType: object.contentType || asset.mimeType || "application/octet-stream",
      contentLength: body.byteLength,
    };
  } catch {
    return { ok: false, status: 502, body: "Storage read failed" };
  }
}

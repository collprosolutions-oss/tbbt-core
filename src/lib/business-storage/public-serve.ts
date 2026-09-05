import type { Prisma, PrismaClient } from "@prisma/client";
import {
  readPublicStoredAsset,
  resolveStorageProvider,
  type StorageServiceDeps,
} from "@/lib/business-storage/service";

type Db = PrismaClient | Prisma.TransactionClient;

export type PublicStoredAssetServeResult =
  | {
      ok: true;
      status: 200;
      body: Uint8Array;
      contentType: string;
      contentLength: number;
    }
  | {
      ok: false;
      status: 404 | 502 | 503;
      body: string;
    };

/**
 * Unauthenticated public image delivery. Only READY + PUBLIC rows are
 * readable. Bytes come from the private bucket through the storage
 * provider — the bucket itself is never made public.
 */
export async function servePublicStoredAsset(
  db: Db,
  assetId: string,
  deps?: Pick<StorageServiceDeps, "provider">,
): Promise<PublicStoredAssetServeResult> {
  const id = assetId.trim();
  if (!id) {
    return { ok: false, status: 404, body: "Not found" };
  }

  const asset = await readPublicStoredAsset(db, id);
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

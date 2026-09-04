import { NextResponse } from "next/server";
import { readManagedStorageConfig } from "@/lib/business-storage/config";
import { createR2StorageProvider } from "@/lib/business-storage/r2-provider";
import { readPublicStoredAsset } from "@/lib/business-storage/service";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await context.params;
  if (!assetId) {
    return new NextResponse("Not found", { status: 404 });
  }

  const asset = await readPublicStoredAsset(prisma, assetId);
  if (!asset) {
    return new NextResponse("Not found", { status: 404 });
  }

  const config = readManagedStorageConfig();
  if (config?.publicBaseUrl) {
    const url = `${config.publicBaseUrl}/${asset.storageKey}`;
    return NextResponse.redirect(url, 302);
  }

  if (!config) {
    return new NextResponse("Storage is not configured", { status: 503 });
  }

  const provider = createR2StorageProvider(config);
  const object = await provider.getObject({
    bucket: asset.storageAccount.bucketName,
    key: asset.storageKey,
  });
  if (!object) {
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(Buffer.from(object.body), {
    status: 200,
    headers: {
      "Content-Type": object.contentType || asset.mimeType,
      "Content-Length": String(object.sizeBytes),
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}

import { NextResponse } from "next/server";
import { servePublicStoredAsset } from "@/lib/business-storage/public-serve";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await context.params;
  const result = await servePublicStoredAsset(prisma, assetId);
  if (!result.ok) {
    return new NextResponse(result.body, { status: result.status });
  }

  return new NextResponse(result.body, {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Content-Length": String(result.contentLength),
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}

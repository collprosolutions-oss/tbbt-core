import { NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { servePrivateStoredAsset } from "@/lib/business-storage/private-serve";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  let access;
  try {
    access = await requireBusinessAccess();
  } catch {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { assetId } = await context.params;
  const result = await servePrivateStoredAsset(prisma, assetId, access.businessId);
  if (!result.ok) {
    return new NextResponse(result.body, { status: result.status });
  }

  return new NextResponse(Buffer.from(result.body), {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Content-Length": String(result.contentLength),
      "Cache-Control": "private, no-store",
    },
  });
}

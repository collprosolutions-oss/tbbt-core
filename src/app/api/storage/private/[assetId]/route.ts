import { NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { authorizePrivateStoredAssetDownload } from "@/lib/business-storage/private-serve";
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
  const result = await authorizePrivateStoredAssetDownload(
    prisma,
    assetId,
    access.businessId,
    {
      viewer: {
        role: access.workspace.role,
        membershipId: access.workspace.membership.id,
      },
    },
  );
  if (!result.ok) {
    return new NextResponse(result.body, { status: result.status });
  }

  const response = NextResponse.redirect(result.url, 302);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

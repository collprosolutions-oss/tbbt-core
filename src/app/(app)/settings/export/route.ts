import { NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { CAPABILITIES, roleHasCapability } from "@/lib/authorization";
import { buildBusinessExportZip } from "@/lib/business-export";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await requireBusinessAccess();
  if (!roleHasCapability(access.workspace.role, CAPABILITIES.MANAGE_SETTINGS)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const exported = await buildBusinessExportZip(prisma, access.businessId);
  return new NextResponse(new Uint8Array(exported.bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${exported.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

import { NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { buildAccountingExportZip, canExportBusinessData } from "@/lib/accounting-export";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await requireBusinessAccess();
  if (!canExportBusinessData(access.workspace.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const exported = await buildAccountingExportZip(prisma, access.businessId);
  return new NextResponse(new Uint8Array(exported.bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${exported.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

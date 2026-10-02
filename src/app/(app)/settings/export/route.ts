import { NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { runBusinessExportDownload } from "@/lib/business-export";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await requireBusinessAccess();
  const exported = await runBusinessExportDownload(prisma, access);
  if (!exported.ok) {
    return NextResponse.json({ error: exported.error }, { status: exported.status });
  }

  return new NextResponse(new Uint8Array(exported.body), {
    status: 200,
    headers: {
      "Content-Type": exported.contentType,
      "Content-Disposition": `attachment; filename="${exported.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

import { NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { runCustomerRecordsExportDownload } from "@/lib/customer-records-export";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await requireBusinessAccess();
  const url = new URL(request.url);
  const exported = await runCustomerRecordsExportDownload(prisma, access, {
    cursor: url.searchParams.get("cursor"),
    customerId: url.searchParams.get("customerId"),
  });
  if (!exported.ok) {
    return NextResponse.json({ error: exported.error }, { status: exported.status });
  }

  return new NextResponse(exported.body, {
    status: 200,
    headers: {
      "Content-Type": exported.contentType,
      "Content-Disposition": `attachment; filename="${exported.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

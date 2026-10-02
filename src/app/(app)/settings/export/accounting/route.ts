import { NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { runAccountingExportDownload } from "@/lib/accounting-export";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await requireBusinessAccess();
  const downloaded = await runAccountingExportDownload(prisma, access);
  if (!downloaded.ok) {
    return NextResponse.json({ error: downloaded.error }, { status: downloaded.status });
  }
  return new NextResponse(new Uint8Array(downloaded.bytes), {
    status: downloaded.status,
    headers: downloaded.headers,
  });
}

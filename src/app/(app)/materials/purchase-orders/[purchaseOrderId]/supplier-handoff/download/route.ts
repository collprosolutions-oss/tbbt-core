import { NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { runPurchaseOrderSupplierHandoffDownload } from "@/lib/purchase-order-export";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ purchaseOrderId: string }> },
) {
  const { purchaseOrderId } = await params;
  const access = await requireBusinessAccess();
  const exported = await runPurchaseOrderSupplierHandoffDownload(prisma, access, {
    purchaseOrderId,
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

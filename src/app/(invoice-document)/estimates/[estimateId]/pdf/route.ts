import { NextResponse } from "next/server";
import { requireManagementPageAccess } from "@/lib/access";
import { loadEstimateDocumentForBusiness } from "@/lib/estimate-document";
import { renderEstimatePdf } from "@/lib/estimate-pdf";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ estimateId: string }> },
) {
  const { estimateId } = await params;
  const access = await requireManagementPageAccess();
  const document = await loadEstimateDocumentForBusiness(
    estimateId,
    access.businessId,
  );

  if (!document) {
    return new NextResponse("Estimate not found.", { status: 404 });
  }

  const pdf = await renderEstimatePdf(document);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${document.pdfFilename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

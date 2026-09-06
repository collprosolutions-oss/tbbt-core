import { NextResponse } from "next/server";
import { loadEstimateDocumentByToken } from "@/lib/estimate-document";
import { renderEstimatePdf } from "@/lib/estimate-pdf";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const document = await loadEstimateDocumentByToken(token);

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

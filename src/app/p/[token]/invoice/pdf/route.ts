import { NextResponse } from "next/server";
import { loadInvoiceDocumentForProjectToken } from "@/lib/invoice-document";
import { renderInvoicePdf } from "@/lib/invoice-pdf";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const document = await loadInvoiceDocumentForProjectToken(token);

  if (!document) {
    return new NextResponse("Invoice not found.", { status: 404 });
  }

  const pdf = await renderInvoicePdf(document);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${document.pdfFilename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

import { NextResponse } from "next/server";
import { requireManagementPageAccess } from "@/lib/access";
import { loadInvoiceDocumentForBusiness } from "@/lib/invoice-document";
import { renderInvoicePdf } from "@/lib/invoice-pdf";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  const { invoiceId } = await params;
  const access = await requireManagementPageAccess();
  const document = await loadInvoiceDocumentForBusiness(
    invoiceId,
    access.businessId,
  );

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

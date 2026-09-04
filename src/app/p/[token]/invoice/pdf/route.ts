import { NextResponse } from "next/server";
import { loadInvoiceDocumentForProjectToken } from "@/lib/invoice-document";
import { reconcileProjectTokenCheckoutPayment } from "@/lib/payments";
import { renderInvoicePdf } from "@/lib/invoice-pdf";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  await reconcileProjectTokenCheckoutPayment(prisma, token);
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

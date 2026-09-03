import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InvoiceDocument } from "@/components/invoices/invoice-document";
import { InvoicePreviewToolbar } from "@/components/invoices/invoice-preview-toolbar";
import { requireManagementPageAccess } from "@/lib/access";
import { loadInvoiceDocumentForBusiness } from "@/lib/invoice-document";

export const metadata: Metadata = {
  title: "Invoice preview",
};

export default async function InvoicePreviewPage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  const access = await requireManagementPageAccess();
  const document = await loadInvoiceDocumentForBusiness(
    invoiceId,
    access.businessId,
  );

  if (!document) {
    notFound();
  }

  return (
    <main>
      <InvoicePreviewToolbar
        backHref={`/invoices/${document.invoiceId}`}
        backLabel="Back to invoice"
        pdfHref={`/invoices/${document.invoiceId}/pdf`}
      />
      <div className="mx-auto max-w-3xl px-4 py-8 print:max-w-none print:px-0 print:py-0">
        <InvoiceDocument document={document} />
      </div>
    </main>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EstimateDocument } from "@/components/estimates/estimate-document";
import { InvoicePreviewToolbar } from "@/components/invoices/invoice-preview-toolbar";
import { loadEstimateDocumentByToken } from "@/lib/estimate-document";

export const metadata: Metadata = {
  title: "Estimate",
};

export default async function PublicEstimatePrintPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const document = await loadEstimateDocumentByToken(token);

  if (!document) {
    notFound();
  }

  return (
    <main>
      <InvoicePreviewToolbar
        backHref={`/e/${document.publicToken}`}
        backLabel="Back to estimate"
        pdfHref={`/e/${document.publicToken}/pdf`}
      />
      <div className="mx-auto max-w-3xl px-4 py-8 print:max-w-none print:px-0 print:py-0">
        <EstimateDocument document={document} />
      </div>
    </main>
  );
}

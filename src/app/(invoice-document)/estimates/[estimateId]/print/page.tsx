import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EstimateDocument } from "@/components/estimates/estimate-document";
import { InvoicePreviewToolbar } from "@/components/invoices/invoice-preview-toolbar";
import { requireManagementPageAccess } from "@/lib/access";
import { loadEstimateDocumentForBusiness } from "@/lib/estimate-document";

export const metadata: Metadata = {
  title: "Estimate preview",
};

export default async function EstimatePrintPage({
  params,
}: {
  params: Promise<{ estimateId: string }>;
}) {
  const { estimateId } = await params;
  const access = await requireManagementPageAccess();
  const document = await loadEstimateDocumentForBusiness(
    estimateId,
    access.businessId,
  );

  if (!document) {
    notFound();
  }

  return (
    <main>
      <InvoicePreviewToolbar
        backHref={`/estimates/${document.estimateId}`}
        backLabel="Back to estimate"
        pdfHref={`/estimates/${document.estimateId}/pdf`}
      />
      <div className="mx-auto max-w-3xl px-4 py-8 print:max-w-none print:px-0 print:py-0">
        <EstimateDocument document={document} />
      </div>
    </main>
  );
}

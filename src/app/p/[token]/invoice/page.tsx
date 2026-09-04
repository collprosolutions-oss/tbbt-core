import type { Metadata } from "next";
import { InvoiceDocument } from "@/components/invoices/invoice-document";
import { InvoicePreviewToolbar } from "@/components/invoices/invoice-preview-toolbar";
import { loadInvoiceDocumentForProjectToken } from "@/lib/invoice-document";
import { reconcileProjectTokenCheckoutPayment } from "@/lib/payments";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Invoice",
};

export default async function CustomerInvoicePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  await reconcileProjectTokenCheckoutPayment(prisma, token);
  const document = await loadInvoiceDocumentForProjectToken(token);

  if (!document) {
    return (
      <main className="flex min-h-full items-center justify-center px-4 py-10">
        <p className="text-sm text-neutral-600">
          This invoice is not available.
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-full bg-neutral-100 print:bg-white">
      <InvoicePreviewToolbar
        backHref={`/p/${token}`}
        backLabel="Back to project"
        pdfHref={`/p/${token}/invoice/pdf`}
      />
      <div className="mx-auto max-w-3xl px-4 py-8 print:max-w-none print:px-0 print:py-0">
        <InvoiceDocument document={document} />
      </div>
    </main>
  );
}

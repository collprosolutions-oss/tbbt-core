import type { Metadata } from "next";
import { InvoiceDocument } from "@/components/invoices/invoice-document";
import { InvoicePreviewToolbar } from "@/components/invoices/invoice-preview-toolbar";
import { PayInvoiceButton } from "@/components/portal/pay-invoice-button";
import { formatMoney } from "@/lib/format";
import { loadInvoiceDocumentForProjectToken } from "@/lib/invoice-document";
import {
  getBusinessPaymentStatus,
  invoiceDueCents,
  reconcileProjectTokenCheckoutPayment,
  shouldShowPayInvoice,
} from "@/lib/payments";
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

  const payable = await prisma.job.findUnique({
    where: { projectToken: token },
    select: {
      business: { select: { id: true } },
      invoices: {
        where: { id: document.invoiceId },
        take: 1,
        select: { status: true, total: true },
      },
    },
  });
  const invoice = payable?.invoices[0] ?? null;
  const payment = payable
    ? await getBusinessPaymentStatus(prisma, payable.business.id)
    : null;
  const showPayInvoice = Boolean(
    invoice &&
      payment &&
      shouldShowPayInvoice({
        invoiceStatus: invoice.status,
        amountDueCents: invoiceDueCents(invoice.status, invoice.total),
        paymentReady: payment.paymentReady,
      }),
  );

  return (
    <main className="min-h-full bg-neutral-100 print:bg-white">
      <InvoicePreviewToolbar
        backHref={`/p/${token}`}
        backLabel="Back to project"
        pdfHref={`/p/${token}/invoice/pdf`}
      />
      {showPayInvoice && invoice ? (
        <div className="mx-auto flex max-w-3xl justify-end px-4 pt-4 print:hidden">
          <PayInvoiceButton
            token={token}
            amountLabel={formatMoney(invoice.total)}
            surface="light"
          />
        </div>
      ) : null}
      <div className="mx-auto max-w-3xl px-4 py-8 print:max-w-none print:px-0 print:py-0">
        <InvoiceDocument document={document} />
      </div>
    </main>
  );
}

import { CustomerEstimateLineSections } from "@/components/estimates/customer-estimate-line-sections";
import {
  INVOICE_DOCUMENT_LOGO_HEIGHT_PX,
  INVOICE_LABOR_SECTION_TITLE,
  INVOICE_TOTAL_CUSTOMER_LABEL,
  type InvoiceDocumentView,
} from "@/lib/invoice-document";

export function InvoiceDocument({
  document: invoice,
}: {
  document: InvoiceDocumentView;
}) {
  return (
    <article className="invoice-sheet bg-white p-8 text-neutral-900 shadow-sm print:p-0 print:shadow-none">
      <header className="flex flex-wrap items-start justify-between gap-6 border-b border-neutral-200 pb-6">
        <div className="min-w-0 space-y-2">
          {invoice.business.logoSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={invoice.business.logoSrc}
              alt={invoice.business.name}
              className="w-auto bg-transparent object-contain"
              style={{ height: INVOICE_DOCUMENT_LOGO_HEIGHT_PX }}
            />
          ) : null}
          <p className="text-lg font-semibold tracking-tight">
            {invoice.business.name}
          </p>
          {invoice.business.phone ? (
            <p className="text-sm text-neutral-600">{invoice.business.phone}</p>
          ) : null}
          {invoice.business.email ? (
            <p className="text-sm text-neutral-600">{invoice.business.email}</p>
          ) : null}
          {invoice.business.website ? (
            <p className="text-sm text-neutral-600">{invoice.business.website}</p>
          ) : null}
        </div>
        <div className="text-right">
          <p className="text-3xl font-semibold tracking-wide">INVOICE</p>
          <p className="mt-2 text-sm font-medium">{invoice.invoiceNumber}</p>
          <p className="mt-1 text-sm text-neutral-600">
            Date: {invoice.invoiceDateLabel}
          </p>
          <p className="mt-1 text-sm text-neutral-600">
            Status: {invoice.statusLabel}
          </p>
          {invoice.paidAtLabel ? (
            <p className="mt-1 text-sm text-neutral-600">
              Paid: {invoice.paidAtLabel}
            </p>
          ) : null}
        </div>
      </header>

      <section className="mt-6 grid gap-6 sm:grid-cols-2">
        <div>
          <h2 className="text-xs font-semibold tracking-wider text-neutral-500">
            BILL TO
          </h2>
          <p className="mt-2 font-medium">
            {invoice.customer.name || "Customer"}
          </p>
          {invoice.customer.email ? (
            <p className="mt-1 text-sm text-neutral-600">
              {invoice.customer.email}
            </p>
          ) : null}
          {invoice.customer.phone ? (
            <p className="mt-1 text-sm text-neutral-600">
              {invoice.customer.phone}
            </p>
          ) : null}
        </div>
        {invoice.serviceAddress ? (
          <div>
            <h2 className="text-xs font-semibold tracking-wider text-neutral-500">
              SERVICE ADDRESS
            </h2>
            <p className="mt-2 whitespace-pre-line text-sm text-neutral-700">
              {invoice.serviceAddress}
            </p>
          </div>
        ) : null}
      </section>

      <CustomerEstimateLineSections
        laborLines={invoice.laborLines}
        materialLines={invoice.materialLines}
        otherLines={invoice.otherLines}
        appearance="print"
        className="mt-8"
        laborSectionTitle={INVOICE_LABOR_SECTION_TITLE}
      />

      <section className="mt-6 ml-auto w-full max-w-xs space-y-2 text-sm">
        <div className="flex justify-between gap-6">
          <span className="text-neutral-600">Labor</span>
          <span className="tabular-nums">{invoice.laborTotalLabel}</span>
        </div>
        {invoice.materialTotalLabel ? (
          <div className="flex justify-between gap-6">
            <span className="text-neutral-600">Materials</span>
            <span className="tabular-nums">{invoice.materialTotalLabel}</span>
          </div>
        ) : null}
        {invoice.otherTotalLabel ? (
          <div className="flex justify-between gap-6">
            <span className="text-neutral-600">Other</span>
            <span className="tabular-nums">{invoice.otherTotalLabel}</span>
          </div>
        ) : null}
        <div className="flex justify-between gap-6 font-semibold">
          <span>{INVOICE_TOTAL_CUSTOMER_LABEL}</span>
          <span className="tabular-nums">{invoice.totalLabel}</span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-neutral-600">Payments</span>
          <span className="tabular-nums">{invoice.amountPaidLabel}</span>
        </div>
        {invoice.depositPaidLabel ? (
          <div className="flex justify-between gap-6 text-neutral-600">
            <span>Deposit Paid</span>
            <span className="tabular-nums">-{invoice.depositPaidLabel}</span>
          </div>
        ) : null}
        {invoice.otherPaymentsLabel && invoice.depositPaidLabel ? (
          <div className="flex justify-between gap-6 text-neutral-600">
            <span>Other Payments</span>
            <span className="tabular-nums">-{invoice.otherPaymentsLabel}</span>
          </div>
        ) : null}
        <div className="flex justify-between gap-6 border-t border-neutral-200 pt-2 font-semibold">
          <span>Amount Due</span>
          <span className="tabular-nums">{invoice.amountDueLabel}</span>
        </div>
        {invoice.creditLabel ? (
          <p className="text-xs text-neutral-600">{invoice.creditLabel}</p>
        ) : null}
      </section>

      <footer className="mt-10 border-t border-neutral-200 pt-4 text-sm text-neutral-600">
        <p>{invoice.thankYou}</p>
        {invoice.jobReference ? (
          <p className="mt-2 text-xs">
            Reference: {invoice.invoiceNumber}
            {invoice.jobReference ? ` · ${invoice.jobReference}` : ""}
          </p>
        ) : (
          <p className="mt-2 text-xs">Reference: {invoice.invoiceNumber}</p>
        )}
      </footer>
    </article>
  );
}

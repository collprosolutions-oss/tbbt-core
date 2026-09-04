import type { InvoiceDocumentView } from "@/lib/invoice-document";

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
              className="h-16 w-auto object-contain"
            />
          ) : null}
          <p className="text-lg font-semibold tracking-tight">
            {invoice.business.name}
          </p>
          {invoice.business.phone ? (
            <p className="text-sm text-neutral-600">{invoice.business.phone}</p>
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
            <p className="mt-2 text-sm text-neutral-700">
              {invoice.serviceAddress}
            </p>
          </div>
        ) : null}
      </section>

      <section className="mt-8">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs tracking-wider text-neutral-500">
              <th className="py-2 pr-3 font-semibold">Description</th>
              <th className="py-2 px-3 text-right font-semibold">Qty</th>
              <th className="py-2 px-3 text-right font-semibold">Rate</th>
              <th className="py-2 pl-3 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lineItems.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-4 text-neutral-500">
                  No line items.
                </td>
              </tr>
            ) : (
              invoice.lineItems.map((line, index) => (
                <tr key={`${line.description}-${index}`} className="border-b border-neutral-100">
                  <td className="py-2.5 pr-3 align-top">{line.description}</td>
                  <td className="py-2.5 px-3 text-right align-top tabular-nums">
                    {line.quantityLabel}
                  </td>
                  <td className="py-2.5 px-3 text-right align-top tabular-nums">
                    {line.unitPriceLabel}
                  </td>
                  <td className="py-2.5 pl-3 text-right align-top tabular-nums">
                    {line.amountLabel}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="mt-6 ml-auto w-full max-w-xs space-y-2 text-sm">
        <div className="flex justify-between gap-6">
          <span className="text-neutral-600">Subtotal</span>
          <span className="tabular-nums">{invoice.subtotalLabel}</span>
        </div>
        <div className="flex justify-between gap-6 font-semibold">
          <span>Total</span>
          <span className="tabular-nums">{invoice.totalLabel}</span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-neutral-600">Payments</span>
          <span className="tabular-nums">{invoice.amountPaidLabel}</span>
        </div>
        <div className="flex justify-between gap-6 border-t border-neutral-200 pt-2 font-semibold">
          <span>Amount due</span>
          <span className="tabular-nums">{invoice.amountDueLabel}</span>
        </div>
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

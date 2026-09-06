import {
  ESTIMATE_DOCUMENT_LOGO_HEIGHT_PX,
  type EstimateDocumentView,
} from "@/lib/estimate-document";

export function EstimateDocument({
  document: estimate,
}: {
  document: EstimateDocumentView;
}) {
  return (
    <article className="invoice-sheet bg-white p-8 text-neutral-900 shadow-sm print:p-0 print:shadow-none">
      <header className="flex flex-wrap items-start justify-between gap-6 border-b border-neutral-200 pb-6">
        <div className="min-w-0 space-y-2">
          {estimate.business.logoSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={estimate.business.logoSrc}
              alt={estimate.business.name}
              className="w-auto bg-transparent object-contain"
              style={{ height: ESTIMATE_DOCUMENT_LOGO_HEIGHT_PX }}
            />
          ) : null}
          <p className="text-lg font-semibold tracking-tight">
            {estimate.business.name}
          </p>
          {estimate.business.phone ? (
            <p className="text-sm text-neutral-600">{estimate.business.phone}</p>
          ) : null}
        </div>
        <div className="text-right">
          <p className="text-3xl font-semibold tracking-wide">ESTIMATE</p>
          <p className="mt-2 text-sm font-medium">{estimate.estimateNumber}</p>
          <p className="mt-1 text-sm text-neutral-600">
            Date: {estimate.estimateDateLabel}
          </p>
          <p className="mt-1 text-sm text-neutral-600">
            Status: {estimate.statusLabel}
          </p>
        </div>
      </header>

      <section className="mt-6 grid gap-6 sm:grid-cols-2">
        <div>
          <h2 className="text-xs font-semibold tracking-wider text-neutral-500">
            PREPARED FOR
          </h2>
          <p className="mt-2 font-medium">
            {estimate.customer.name || "Customer"}
          </p>
          {estimate.customer.email ? (
            <p className="mt-1 text-sm text-neutral-600">
              {estimate.customer.email}
            </p>
          ) : null}
          {estimate.customer.phone ? (
            <p className="mt-1 text-sm text-neutral-600">
              {estimate.customer.phone}
            </p>
          ) : null}
        </div>
        {estimate.serviceAddress ? (
          <div>
            <h2 className="text-xs font-semibold tracking-wider text-neutral-500">
              SERVICE ADDRESS
            </h2>
            <p className="mt-2 text-sm text-neutral-700">
              {estimate.serviceAddress}
            </p>
          </div>
        ) : null}
      </section>

      <section className="mt-8">
        <h2 className="text-xs font-semibold tracking-wider text-neutral-500">
          SERVICES
        </h2>
        <table className="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs tracking-wider text-neutral-500">
              <th className="py-2 pr-3 font-semibold">Description</th>
              <th className="py-2 px-3 text-right font-semibold">Qty</th>
              <th className="py-2 px-3 text-right font-semibold">Rate</th>
              <th className="py-2 pl-3 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {estimate.lineItems.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-4 text-neutral-500">
                  No line items.
                </td>
              </tr>
            ) : (
              estimate.lineItems.map((line, index) => (
                <tr
                  key={`${line.description}-${index}`}
                  className="border-b border-neutral-100"
                >
                  <td className="py-2.5 pr-3 align-top">
                    <div>{line.description}</div>
                    {line.includedWork ? (
                      <div className="mt-1 whitespace-pre-line text-xs text-neutral-600">
                        <div className="font-semibold tracking-wide">
                          Scope / Included Work
                        </div>
                        {line.includedWork}
                      </div>
                    ) : null}
                  </td>
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
          <span className="tabular-nums">{estimate.subtotalLabel}</span>
        </div>
        {estimate.laborMinimumLabel && estimate.laborMinimumAmountLabel ? (
          <div className="flex justify-between gap-6">
            <span className="text-neutral-600">{estimate.laborMinimumLabel}</span>
            <span className="tabular-nums">{estimate.laborMinimumAmountLabel}</span>
          </div>
        ) : null}
        <div className="flex justify-between gap-6 border-t border-neutral-200 pt-2 font-semibold">
          <span>Total</span>
          <span className="tabular-nums">{estimate.totalLabel}</span>
        </div>
      </section>

      {estimate.policies.length > 0 ? (
        <section className="mt-10 border-t border-neutral-200 pt-4 text-sm text-neutral-700">
          <h2 className="text-xs font-semibold tracking-wider text-neutral-500">
            TERMS
          </h2>
          <div className="mt-3 space-y-4">
            {estimate.policies.map((policy) => (
              <div key={policy.title}>
                <p className="font-medium text-neutral-800">{policy.title}</p>
                <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-neutral-600">
                  {policy.body}
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <footer className="mt-8 border-t border-neutral-200 pt-4 text-xs text-neutral-500">
        <p>Reference: {estimate.estimateNumber}</p>
      </footer>
    </article>
  );
}

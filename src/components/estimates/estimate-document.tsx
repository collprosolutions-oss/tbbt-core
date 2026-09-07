import {
  ESTIMATE_DOCUMENT_LOGO_HEIGHT_PX,
  ESTIMATE_LABOR_SECTION_TITLE,
  ESTIMATE_MATERIALS_SECTION_TITLE,
  ESTIMATE_OTHER_SECTION_TITLE,
  ESTIMATE_TOTAL_CUSTOMER_LABEL,
  type EstimateDocumentLine,
  type EstimateDocumentView,
} from "@/lib/estimate-document";
import {
  MATERIAL_DEPOSIT_CUSTOMER_LABEL,
  REMAINING_BALANCE_CUSTOMER_LABEL,
} from "@/lib/material-deposit";

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

      <EstimateDocumentLineSections document={estimate} />

      <section className="mt-6 ml-auto w-full max-w-xs space-y-2 text-sm">
        <div className="flex justify-between gap-6">
          <span className="text-neutral-600">Labor</span>
          <span className="tabular-nums">{estimate.laborTotalLabel}</span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-neutral-600">Materials</span>
          <span className="tabular-nums">{estimate.materialTotalLabel}</span>
        </div>
        {estimate.otherTotalLabel ? (
          <div className="flex justify-between gap-6">
            <span className="text-neutral-600">Other</span>
            <span className="tabular-nums">{estimate.otherTotalLabel}</span>
          </div>
        ) : null}
        {estimate.laborMinimumLabel && estimate.laborMinimumAmountLabel ? (
          <div className="flex justify-between gap-6">
            <span className="text-neutral-600">{estimate.laborMinimumLabel}</span>
            <span className="tabular-nums">{estimate.laborMinimumAmountLabel}</span>
          </div>
        ) : null}
        <div className="flex justify-between gap-6 border-t border-neutral-200 pt-2 font-semibold">
          <span>{ESTIMATE_TOTAL_CUSTOMER_LABEL}</span>
          <span className="tabular-nums">{estimate.totalLabel}</span>
        </div>
        {estimate.materialDepositLabel && estimate.remainingBalanceLabel ? (
          <>
            <div className="flex justify-between gap-6 pt-2">
              <span className="text-neutral-600">{MATERIAL_DEPOSIT_CUSTOMER_LABEL}</span>
              <span className="tabular-nums">{estimate.materialDepositLabel}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-neutral-600">{REMAINING_BALANCE_CUSTOMER_LABEL}</span>
              <span className="tabular-nums">{estimate.remainingBalanceLabel}</span>
            </div>
            {estimate.materialDepositNote ? (
              <p className="pt-1 text-xs font-normal text-neutral-500">
                {estimate.materialDepositNote}
              </p>
            ) : null}
          </>
        ) : null}
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

function EstimateDocumentLineSections({
  document: estimate,
}: {
  document: EstimateDocumentView;
}) {
  const hasLines =
    estimate.laborLines.length > 0 ||
    estimate.materialLines.length > 0 ||
    estimate.otherLines.length > 0;
  if (!hasLines) {
    return (
      <section className="mt-8">
        <p className="text-sm text-neutral-500">No line items.</p>
      </section>
    );
  }

  const blocks: Array<{ title: string; lines: EstimateDocumentLine[] }> = [];
  if (estimate.laborLines.length > 0) {
    blocks.push({ title: ESTIMATE_LABOR_SECTION_TITLE, lines: estimate.laborLines });
  }
  if (estimate.materialLines.length > 0) {
    blocks.push({
      title: ESTIMATE_MATERIALS_SECTION_TITLE,
      lines: estimate.materialLines,
    });
  }
  if (estimate.otherLines.length > 0) {
    blocks.push({ title: ESTIMATE_OTHER_SECTION_TITLE, lines: estimate.otherLines });
  }

  return (
    <div className="mt-8 space-y-0">
      {blocks.map((block, index) => (
        <section
          key={block.title}
          className={
            index > 0
              ? "mt-6 border-t-2 border-neutral-400 pt-6"
              : undefined
          }
        >
          <h2 className="text-xs font-semibold tracking-wider text-neutral-500">
            {block.title}
          </h2>
          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs tracking-wider text-neutral-500">
                <th className="py-2 pr-3 font-semibold">Description</th>
                <th className="py-2 px-3 text-right font-semibold">Qty</th>
                <th className="py-2 px-3 text-right font-semibold">Rate</th>
                <th className="py-2 pl-3 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {block.lines.map((line, lineIndex) => (
                <tr
                  key={`${block.title}-${line.description}-${lineIndex}`}
                  className="border-t border-neutral-100"
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
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

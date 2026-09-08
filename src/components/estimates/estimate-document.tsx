import { CustomerEstimateLineSections } from "@/components/estimates/customer-estimate-line-sections";
import { EstimateDocumentTerms } from "@/components/estimates/customer-policy-display";
import {
  ESTIMATE_DOCUMENT_LOGO_HEIGHT_PX,
  ESTIMATE_TOTAL_CUSTOMER_LABEL,
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
          {estimate.business.email ? (
            <p className="text-sm text-neutral-600">{estimate.business.email}</p>
          ) : null}
          {estimate.business.website ? (
            <p className="text-sm text-neutral-600">{estimate.business.website}</p>
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
            <p className="mt-2 whitespace-pre-line text-sm text-neutral-700">
              {estimate.serviceAddress}
            </p>
          </div>
        ) : null}
      </section>

      <CustomerEstimateLineSections
        className="mt-8"
        appearance="print"
        laborLines={estimate.laborLines}
        materialLines={estimate.materialLines}
        otherLines={estimate.otherLines}
      />

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

      {estimate.projectConditions || estimate.terms.length > 0 ? (
        <EstimateDocumentTerms
          className="mt-6 border-t border-neutral-200 pt-4"
          appearance="print"
          projectConditions={estimate.projectConditions}
          terms={estimate.terms}
        />
      ) : null}

      <footer className="mt-8 border-t border-neutral-200 pt-4 text-xs text-neutral-500">
        <p>Reference: {estimate.estimateNumber}</p>
      </footer>
    </article>
  );
}


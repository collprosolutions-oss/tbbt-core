import {
  ESTIMATE_TOTAL_CUSTOMER_LABEL,
  type EstimateDocumentView,
} from "@/lib/estimate-document";
import {
  MATERIAL_DEPOSIT_CUSTOMER_LABEL,
  REMAINING_BALANCE_CUSTOMER_LABEL,
} from "@/lib/material-deposit";

export function CustomerEstimateTotals({
  document: estimate,
}: {
  document: EstimateDocumentView;
}) {
  return (
    <div className="space-y-2 text-sm">
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">Labor</span>
        <span className="tabular-nums">{estimate.laborTotalLabel}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">Materials</span>
        <span className="tabular-nums">{estimate.materialTotalLabel}</span>
      </div>
      {estimate.otherTotalLabel ? (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Other</span>
          <span className="tabular-nums">{estimate.otherTotalLabel}</span>
        </div>
      ) : null}
      {estimate.laborMinimumLabel && estimate.laborMinimumAmountLabel ? (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">{estimate.laborMinimumLabel}</span>
          <span className="tabular-nums">{estimate.laborMinimumAmountLabel}</span>
        </div>
      ) : null}
      <div className="flex justify-between gap-4 border-t border-border pt-2 text-lg font-semibold tracking-tight md:text-2xl">
        <span>{ESTIMATE_TOTAL_CUSTOMER_LABEL}</span>
        <span className="tabular-nums">{estimate.totalLabel}</span>
      </div>
      {estimate.materialDepositLabel && estimate.remainingBalanceLabel ? (
        <>
          <div className="flex justify-between gap-4 pt-2">
            <span className="text-muted-foreground">{MATERIAL_DEPOSIT_CUSTOMER_LABEL}</span>
            <span className="tabular-nums">{estimate.materialDepositLabel}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">{REMAINING_BALANCE_CUSTOMER_LABEL}</span>
            <span className="tabular-nums">{estimate.remainingBalanceLabel}</span>
          </div>
          {estimate.materialDepositNote ? (
            <p className="text-xs text-muted-foreground">{estimate.materialDepositNote}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

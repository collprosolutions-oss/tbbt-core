import { formatMoney } from "@/lib/format";
import { paymentMethodLabel } from "@/lib/invoice-payment";
import type { ProjectPaymentSummary } from "@/lib/project-payments";

export function ProjectPaymentSummaryCard({
  summary,
  warning,
}: {
  summary: ProjectPaymentSummary;
  warning?: string | null;
}) {
  return (
    <div className="space-y-2 text-sm">
      <dl className="space-y-1">
        <div className="flex justify-between gap-3">
          <dt>Estimate Total</dt>
          <dd className="tabular-nums">{formatMoney(summary.estimateTotal)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Required Deposit</dt>
          <dd className="tabular-nums">{formatMoney(summary.requiredDeposit)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Deposit Paid</dt>
          <dd className="tabular-nums">{formatMoney(summary.depositPaid)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Deposit Remaining</dt>
          <dd className="tabular-nums">{formatMoney(summary.depositRemaining)}</dd>
        </div>
        <div className="flex justify-between gap-3 font-medium">
          <dt>Remaining Project Balance</dt>
          <dd className="tabular-nums">{formatMoney(summary.remainingBalance)}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">{summary.depositStatusLabel}</p>
      {warning ? (
        <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
          {warning}
        </p>
      ) : null}
      {summary.credit.gt(0) ? (
        <p className="text-xs text-muted-foreground">
          Credit on account {formatMoney(summary.credit)}. Amount due is $0.00.
        </p>
      ) : null}
      {summary.depositOverage.gt(0) && summary.credit.lte(0) ? (
        <p className="text-xs text-muted-foreground">
          Deposit payments exceed the required deposit by{" "}
          {formatMoney(summary.depositOverage)}. This amount is applied to the
          remaining project balance.
        </p>
      ) : null}
      {summary.payments.length > 0 ? (
        <div className="space-y-1 pt-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Payments
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {summary.payments.map((payment) => (
              <li key={payment.id}>
                {formatMoney(payment.amount)} ·{" "}
                {payment.purpose === "MATERIAL_DEPOSIT" ? "Deposit" : "Payment"} ·{" "}
                {paymentMethodLabel(payment.method) ?? payment.method}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

import { formatMoney } from "@/lib/format";

/**
 * Owner Record Deposit form visibility. Does not change deposit math —
 * remaining is already computed by buildProjectPaymentSummary.
 */
export function shouldShowOwnerRecordDepositForm(summary: {
  requiredDeposit: { gt: (n: number) => boolean };
  depositRemaining: { gt: (n: number) => boolean };
}) {
  return summary.requiredDeposit.gt(0) && summary.depositRemaining.gt(0);
}

export function ownerMaterialDepositPaidConfirmation(
  depositPaid: { toString(): string } | string | number,
) {
  return `✓ Material deposit paid — ${formatMoney(depositPaid)}`;
}

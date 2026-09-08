"use client";

import { useActionState, useEffect } from "react";
import {
  approveEstimate,
  type ApproveEstimateResult,
} from "@/app/actions/public-estimate";
import { PayDepositButton } from "@/components/estimates/pay-deposit-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const initialState: ApproveEstimateResult = {};

export function ApproveEstimateButton({
  publicToken,
  status,
  currentVersionId,
  requiredDeposit,
  depositPaid,
  depositRemaining,
  depositStatus,
  paymentReady,
  remainingProjectBalance,
}: {
  publicToken: string;
  status: string;
  currentVersionId?: string;
  requiredDeposit?: string | null;
  depositPaid?: string | null;
  depositRemaining?: string | null;
  remainingProjectBalance?: string | null;
  depositStatus?: "none" | "due" | "partial" | "paid";
  paymentReady?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    approveEstimate,
    initialState,
  );
  const currentStatus = state.status ?? status;
  const needsDeposit =
    Boolean(requiredDeposit) &&
    depositStatus !== "none" &&
    depositStatus !== "paid";

  useEffect(() => {
    if (
      state.status === "APPROVED" &&
      needsDeposit &&
      paymentReady
    ) {
      const form = document.createElement("form");
      form.method = "post";
      form.action = `/e/${publicToken}/pay`;
      document.body.appendChild(form);
      form.submit();
    }
  }, [state.status, needsDeposit, paymentReady, publicToken]);

  if (currentStatus === "APPROVED") {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium">Status: APPROVED</p>
        {needsDeposit ? (
          <>
            <p className="text-sm">
              Material Deposit Due: {depositRemaining ?? requiredDeposit}
            </p>
            {depositStatus === "partial" && depositPaid ? (
              <p className="text-sm text-muted-foreground">
                Deposit paid so far: {depositPaid}
              </p>
            ) : null}
            {paymentReady ? (
              <PayDepositButton
                publicToken={publicToken}
                amountLabel={depositRemaining ?? requiredDeposit ?? "$0.00"}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Online deposit payment is not available yet. The deposit is
                still due.
              </p>
            )}
          </>
        ) : depositStatus === "paid" ? (
          <>
            <p className="text-sm">
              Deposit Paid: {depositPaid ?? requiredDeposit}
            </p>
            {remainingProjectBalance ? (
              <p className="text-sm">
                Remaining Balance: {remainingProjectBalance}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    );
  }

  if (currentStatus !== "SENT") {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium">Status: {currentStatus}</p>
        <p className="text-sm text-muted-foreground">
          This estimate is not ready to approve.
        </p>
      </div>
    );
  }

  const approveLabel =
    needsDeposit && paymentReady
      ? `Approve Estimate & Pay ${requiredDeposit ?? "$0.00"} Deposit`
      : "Approve Estimate";

  return (
    <form action={formAction}>
      <input type="hidden" name="publicToken" value={publicToken} />
      <input
        type="hidden"
        name="estimateVersionId"
        value={currentVersionId ?? ""}
      />
      {state.error ? (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <p className="mb-3 text-sm">Status: SENT</p>
      {needsDeposit && paymentReady ? (
        <p className="mb-3 text-sm text-muted-foreground">
          Approval records your acceptance first. You will then be asked to
          pay the {requiredDeposit ?? "$0.00"} material deposit.
        </p>
      ) : null}
      {needsDeposit && !paymentReady ? (
        <p className="mb-3 text-sm text-muted-foreground">
          Approval records your acceptance. The{" "}
          {requiredDeposit ?? "$0.00"} material deposit is still due. Online
          deposit payment is not available yet.
        </p>
      ) : null}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Approving…" : approveLabel}
      </Button>
    </form>
  );
}

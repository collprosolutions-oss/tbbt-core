import { PayDepositButton } from "@/components/estimates/pay-deposit-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { MaterialDepositStatus } from "@/lib/project-payments";

export function PortalMaterialDepositCard({
  token,
  requiredLabel,
  paidLabel,
  remainingLabel,
  status,
  showPay,
  remaining,
  checkout,
}: {
  token: string;
  requiredLabel: string;
  paidLabel: string;
  remainingLabel: string;
  status: MaterialDepositStatus;
  showPay: boolean;
  remaining: boolean;
  checkout?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Material Deposit</CardTitle>
        <CardDescription>
          {status === "paid"
            ? "Deposit Paid"
            : status === "partial"
              ? "A remaining material deposit is still due."
              : "A material deposit is due before work continues."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Required Material Deposit</span>
          <span className="tabular-nums">{requiredLabel}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Deposit Paid</span>
          <span className="tabular-nums">{paidLabel}</span>
        </div>
        <div className="flex justify-between gap-3 font-medium">
          <span>Deposit Remaining</span>
          <span className="tabular-nums">{remainingLabel}</span>
        </div>
        {status === "paid" ? (
          <p className="pt-1 text-sm font-medium">Deposit Paid</p>
        ) : null}
        {showPay ? (
          <div className="pt-2">
            <PayDepositButton
              publicToken={token}
              amountLabel={remainingLabel}
              payPath={`/p/${token}/deposit`}
              remaining={remaining}
            />
          </div>
        ) : null}
        {checkout === "cancelled" && status !== "paid" ? (
          <p className="pt-1 text-muted-foreground">
            Deposit payment was cancelled. The deposit remains due.
          </p>
        ) : null}
        {checkout === "unavailable" && status !== "paid" ? (
          <p className="pt-1 text-muted-foreground">
            Online deposit payment is not available right now. The deposit
            remains due.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

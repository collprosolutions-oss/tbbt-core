"use client";

import { useActionState } from "react";
import {
  activateBusinessTradeAction,
  deactivateBusinessTradeAction,
  type BusinessTradeActionState,
} from "@/app/actions/business-trades";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { OperatingWriteGate, useSaasOperating } from "@/components/saas/saas-operating-context";

const initial: BusinessTradeActionState = {};

export function BusinessTradesForm({
  trades,
  available,
  canEdit,
}: {
  trades: Array<{ code: string; label: string; status: string }>;
  available: Array<{ code: string; label: string }>;
  canEdit: boolean;
}) {
  const [activateState, activateAction, activatePending] = useActionState(
    activateBusinessTradeAction,
    initial,
  );
  const [deactivateState, deactivateAction, deactivatePending] = useActionState(
    deactivateBusinessTradeAction,
    initial,
  );
  const operating = useSaasOperating();
  const activeCodes = new Set(trades.map((trade) => trade.code));

  if (!operating.canOperate) {
    return <OperatingWriteGate fallbackLabel="Manage trades" />;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Trades share this business identity. Customers, jobs, invoices, and the
        public site stay on the same slug.
      </p>
      {activateState.error || deactivateState.error ? (
        <Alert variant="destructive">
          <AlertDescription>{activateState.error || deactivateState.error}</AlertDescription>
        </Alert>
      ) : null}
      {activateState.message || deactivateState.message ? (
        <Alert>
          <AlertDescription>{activateState.message || deactivateState.message}</AlertDescription>
        </Alert>
      ) : null}
      <ul className="space-y-2 text-sm">
        {available.map((trade) => {
          const active = activeCodes.has(trade.code);
          return (
            <li key={trade.code} className="flex items-center justify-between gap-3">
              <span>
                {trade.label}
                {active ? " · active" : " · not active"}
              </span>
              {canEdit ? (
                <form action={active ? deactivateAction : activateAction}>
                  <input type="hidden" name="tradeCode" value={trade.code} />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={activatePending || deactivatePending}
                  >
                    {active ? "Deactivate" : "Activate"}
                  </Button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

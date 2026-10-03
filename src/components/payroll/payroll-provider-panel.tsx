"use client";

import { useActionState } from "react";
import {
  disconnectPayrollProviderAction,
  importPayrollProviderFactsAction,
  refreshPayrollProviderAction,
  reviewPayrollProviderFactAction,
  startPayrollProviderConnectAction,
  type PayrollConnectActionState,
} from "@/app/actions/payroll-connect";
import type { PayrollConnectView } from "@/lib/payroll-connect/view";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const initialState: PayrollConnectActionState = {};

export function PayrollProviderPanel({
  view,
  notice,
}: {
  view: PayrollConnectView;
  notice: string | null;
}) {
  const [connectState, connectAction, connectPending] = useActionState(
    startPayrollProviderConnectAction,
    initialState,
  );
  const [syncState, syncAction, syncPending] = useActionState(importPayrollProviderFactsAction, initialState);
  const [refreshState, refreshAction, refreshPending] = useActionState(
    refreshPayrollProviderAction,
    initialState,
  );
  const [disconnectState, disconnectAction, disconnectPending] = useActionState(
    disconnectPayrollProviderAction,
    initialState,
  );
  const [reviewState, reviewAction, reviewPending] = useActionState(
    reviewPayrollProviderFactAction,
    initialState,
  );
  const message =
    notice || connectState.message || syncState.message || refreshState.message || disconnectState.message || reviewState.message;
  const error =
    connectState.error || syncState.error || refreshState.error || disconnectState.error || reviewState.error;

  return (
    <Card id="gusto-payroll">
      <CardHeader>
        <CardTitle>Gusto payroll facts</CardTitle>
        <CardDescription>{view.headline}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p>{view.detail}</p>
        <p className="text-muted-foreground">{view.partnerNote}</p>
        <p className="text-muted-foreground">{view.factsNote}</p>
        <p className="text-muted-foreground">{view.companyExclusivityNote}</p>
        {view.phase === "NOT_AVAILABLE" ? (
          <p>
            Required environment variables: {view.requiredEnv.join(", ")}.
            {view.missingEnv.length > 0 ? ` Missing now: ${view.missingEnv.join(", ")}.` : null}
          </p>
        ) : null}
        {view.externalCompanyId ? <p>Gusto company {view.externalCompanyId}</p> : null}
        {view.lastSyncedAt ? <p>Last import {view.lastSyncedAt}</p> : null}
        {view.lastError && view.lastError !== view.headline ? <p>{view.lastError}</p> : null}
        {view.importCaution && view.importCaution !== view.detail ? <p>{view.importCaution}</p> : null}
        {message ? <p>{message}</p> : null}
        {error ? <p>{error}</p> : null}

        <div className="flex flex-wrap gap-2">
          {view.showConnectButton ? (
            <form action={connectAction}>
              <Button type="submit" size="sm" disabled={connectPending}>
                {view.phase === "NEEDS_RECONNECT" || view.phase === "DISCONNECTED" ? "Reconnect" : "Connect Gusto"}
              </Button>
            </form>
          ) : null}
          {view.canSync ? (
            <form action={syncAction}>
              <Button type="submit" size="sm" variant="outline" disabled={syncPending}>
                Import processed payroll facts
              </Button>
            </form>
          ) : null}
          {view.canSync ? (
            <form action={refreshAction}>
              <Button type="submit" size="sm" variant="outline" disabled={refreshPending}>
                Check connection
              </Button>
            </form>
          ) : null}
          {view.canDisconnect ? (
            <form action={disconnectAction}>
              <Button type="submit" size="sm" variant="outline" disabled={disconnectPending}>
                Disconnect
              </Button>
            </form>
          ) : null}
        </div>
        {view.canDisconnect ? <p className="text-muted-foreground">{view.disconnectNote}</p> : null}

        {view.facts.length > 0 ? (
          <div className="space-y-3">
            {view.facts.map((fact) => (
              <article key={fact.id} className="rounded-md border p-3">
                <p className="font-medium">
                  {fact.providerPayrollId} · check date {fact.checkDate ?? "not reported"}
                </p>
                <p>
                  Pay period {fact.payPeriodStart ?? "not reported"} to {fact.payPeriodEnd ?? "not reported"}.
                  Processed as reported. Gross {fact.grossLabel}. Employer taxes {fact.employerTaxesLabel}.
                  Employer benefits {fact.employerBenefitsLabel}. Review {fact.reviewStatus}.
                </p>
                {fact.changeNote ? <p>{fact.changeNote}</p> : null}
                <ul className="mt-2 space-y-1">
                  {fact.lines.map((line, index) => (
                    <li key={`${fact.id}-${line.providerEmployeeId ?? index}`}>
                      {line.employeeName ?? "Name not reported"}
                      {line.providerEmployeeId ? ` (${line.providerEmployeeId})` : ""} · gross {line.grossLabel}
                    </li>
                  ))}
                </ul>
                {fact.recordedPayrollRuns.length > 0 ? (
                  <ul className="mt-2 space-y-1 text-muted-foreground">
                    {fact.recordedPayrollRuns.map((run) => (
                      <li key={run.id}>{run.label}</li>
                    ))}
                  </ul>
                ) : null}
                {view.canReview ? (
                  <div className="mt-2 flex gap-2">
                    <form action={reviewAction}>
                      <input type="hidden" name="factId" value={fact.id} />
                      <input type="hidden" name="reviewStatus" value="ACCEPTED" />
                      <Button type="submit" size="sm" variant="outline" disabled={reviewPending}>
                        Accept
                      </Button>
                    </form>
                    <form action={reviewAction}>
                      <input type="hidden" name="factId" value={fact.id} />
                      <input type="hidden" name="reviewStatus" value="IGNORED" />
                      <Button type="submit" size="sm" variant="outline" disabled={reviewPending}>
                        Ignore
                      </Button>
                    </form>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

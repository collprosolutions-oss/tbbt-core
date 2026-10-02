"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  acceptBankReconciliationMatchAction,
  ignoreBankReconciliationRowAction,
  rejectBankReconciliationMatchAction,
  type BankReconciliationActionState,
} from "@/app/actions/bank-reconciliation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BANK_NOT_A_BALANCE_MESSAGE,
  BANK_NOT_A_PAYMENT_MESSAGE,
  BANK_RECONCILIATION_ROUTE,
  bankDirectionLabel,
  bankMatchKindLabel,
  bankRowStatusLabel,
  formatSignedCents,
} from "@/lib/bank-reconciliation-copy";

const initialState: BankReconciliationActionState = {};

export type ReconciliationMatchView = {
  id: string;
  candidateKind: string;
  candidateId: string;
  score: number;
  matchReason: string;
  status: string;
  candidateLabel: string | null;
  candidateAmount: string | null;
  candidateDate: string | null;
};

export type ReconciliationRowView = {
  id: string;
  rowNumber: number;
  postedOn: string | null;
  description: string;
  amountCents: number;
  direction: string;
  reviewStatus: string;
  invalidReason: string | null;
  reversalOfRowNumber: number | null;
  duplicateOfRowNumber: number | null;
  matches: ReconciliationMatchView[];
};

function statusVariant(status: string): "outline" | "success" | "warning" | "destructive" | "secondary" {
  if (status === "ACCEPTED") return "success";
  if (status === "CANDIDATE") return "warning";
  if (status === "INVALID") return "destructive";
  if (status === "REVERSED" || status === "DUPLICATE" || status === "ALREADY_SEEN") return "secondary";
  return "outline";
}

function MatchReview({
  importId,
  match,
}: {
  importId: string;
  match: ReconciliationMatchView;
}) {
  const [acceptState, acceptAction, acceptPending] = useActionState(
    acceptBankReconciliationMatchAction,
    initialState,
  );
  const [rejectState, rejectAction, rejectPending] = useActionState(
    rejectBankReconciliationMatchAction,
    initialState,
  );
  const error = acceptState.error ?? rejectState.error;

  return (
    <div className="space-y-2 rounded-md border p-3">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {bankMatchKindLabel(match.candidateKind)}{" "}
          <span className="font-mono text-xs">{match.candidateId.slice(-8)}</span>
        </p>
        <Badge variant={match.status === "ACCEPTED" ? "success" : "outline"}>{match.status}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {match.candidateLabel ?? "Recorded TBBT transaction"}
        {match.candidateAmount ? ` · $${match.candidateAmount}` : ""}
        {match.candidateDate ? ` · ${match.candidateDate}` : ""}
      </p>
      <p className="text-xs text-muted-foreground">{match.matchReason}</p>
      {match.status === "SUGGESTED" ? (
        <div className="flex flex-wrap gap-2">
          <form action={acceptAction}>
            <input type="hidden" name="importId" value={importId} />
            <input type="hidden" name="matchId" value={match.id} />
            <Button type="submit" size="sm" disabled={acceptPending || rejectPending}>
              {acceptPending ? "Accepting…" : "Accept match"}
            </Button>
          </form>
          <form action={rejectAction}>
            <input type="hidden" name="importId" value={importId} />
            <input type="hidden" name="matchId" value={match.id} />
            <Button type="submit" size="sm" variant="outline" disabled={acceptPending || rejectPending}>
              {rejectPending ? "Rejecting…" : "Reject"}
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function RowIgnore({ importId, row }: { importId: string; row: ReconciliationRowView }) {
  const [state, action, pending] = useActionState(ignoreBankReconciliationRowAction, initialState);
  if (
    row.reviewStatus === "ACCEPTED" ||
    row.reviewStatus === "INVALID" ||
    row.reviewStatus === "IGNORED" ||
    row.reviewStatus === "ALREADY_SEEN"
  ) {
    return null;
  }
  return (
    <form action={action} className="space-y-2">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <input type="hidden" name="importId" value={importId} />
      <input type="hidden" name="rowId" value={row.id} />
      <Button type="submit" size="sm" variant="ghost" disabled={pending}>
        {pending ? "Ignoring…" : "Ignore this row"}
      </Button>
    </form>
  );
}

export function ReconciliationWorkspace({
  importId,
  sourceLabel,
  capturedAtLabel,
  postedDepositCents,
  postedWithdrawalCents,
  netPostedCents,
  acceptedDepositCents,
  acceptedWithdrawalCents,
  rowCount,
  candidateMatchCount,
  unmatchedCount,
  duplicateRowCount,
  reversedCount,
  invalidCount,
  rows,
}: {
  importId: string;
  sourceLabel: string;
  capturedAtLabel: string;
  postedDepositCents: number;
  postedWithdrawalCents: number;
  netPostedCents: number;
  acceptedDepositCents: number;
  acceptedWithdrawalCents: number;
  rowCount: number;
  candidateMatchCount: number;
  unmatchedCount: number;
  duplicateRowCount: number;
  reversedCount: number;
  invalidCount: number;
  rows: ReconciliationRowView[];
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-2 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">{sourceLabel}</p>
            <p className="text-xs text-muted-foreground">Imported {capturedAtLabel}</p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={`${BANK_RECONCILIATION_ROUTE}/${importId}/source`}>Download source CSV</Link>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{BANK_NOT_A_BALANCE_MESSAGE}</p>
        <p className="text-sm text-muted-foreground">{BANK_NOT_A_PAYMENT_MESSAGE}</p>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Posted deposits</dt>
            <dd className="font-medium tabular-nums">{formatSignedCents(postedDepositCents)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Posted withdrawals</dt>
            <dd className="font-medium tabular-nums">{formatSignedCents(-postedWithdrawalCents)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Net posted</dt>
            <dd className="font-medium tabular-nums">{formatSignedCents(netPostedCents)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Accepted matches</dt>
            <dd className="font-medium tabular-nums">
              {formatSignedCents(acceptedDepositCents)} in / {formatSignedCents(-acceptedWithdrawalCents)} out
            </dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          {rowCount} rows · {candidateMatchCount} suggested matches · {unmatchedCount} unmatched ·{" "}
          {duplicateRowCount} duplicates · {reversedCount} reversed · {invalidCount} invalid
        </p>
      </div>

      <div className="space-y-4">
        {rows.map((row) => (
          <div key={row.id} className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium">
                  Row {row.rowNumber} · {row.postedOn ?? "No date"} · {bankDirectionLabel(row.direction)}
                </p>
                <p className="text-sm">{row.description || "No description"}</p>
                <p className="font-mono text-sm tabular-nums">{formatSignedCents(row.amountCents)}</p>
                {row.invalidReason ? (
                  <p className="text-sm text-destructive">{row.invalidReason}</p>
                ) : null}
                {row.duplicateOfRowNumber ? (
                  <p className="text-xs text-muted-foreground">
                    Duplicate of row {row.duplicateOfRowNumber}
                  </p>
                ) : null}
                {row.reversalOfRowNumber ? (
                  <p className="text-xs text-muted-foreground">
                    Reversal of row {row.reversalOfRowNumber}
                  </p>
                ) : null}
              </div>
              <Badge variant={statusVariant(row.reviewStatus)}>{bankRowStatusLabel(row.reviewStatus)}</Badge>
            </div>
            {row.matches.length > 0 ? (
              <div className="space-y-2">
                {row.matches.map((match) => (
                  <MatchReview key={match.id} importId={importId} match={match} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {row.reviewStatus === "ALREADY_SEEN"
                  ? "This row was already imported in an earlier workspace."
                  : "No recorded Payment or Expense candidate in the same-cent, three-day window."}
              </p>
            )}
            <RowIgnore importId={importId} row={row} />
          </div>
        ))}
      </div>
    </div>
  );
}

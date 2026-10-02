"use client";

import { useActionState, useEffect, useState } from "react";
import {
  confirmExpenseReceiptDraftAction,
  extractExpenseReceiptAction,
  type ExpenseActionState,
  type ExpenseExtractActionState,
} from "@/app/actions/expenses";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { shouldRotateAiAttemptId } from "@/lib/ai/types";
import {
  EXPENSE_RECEIPT_EXTRACT_OWNER_ONLY_MESSAGE,
  EXPENSE_RECEIPT_EXTRACT_UNAVAILABLE_MESSAGE,
} from "@/lib/expense-receipt-extract";

const initial: ExpenseExtractActionState = {};
const confirmInitial: ExpenseActionState = {};

function newAttemptId() {
  return crypto.randomUUID();
}

export function RequestReceiptExtractForm({
  storedAssetId,
  expenseId,
  reviewStatus,
  canExtract,
  providerConfigured,
}: {
  storedAssetId: string | null;
  expenseId: string;
  reviewStatus: string;
  canExtract: boolean;
  providerConfigured: boolean;
}) {
  const [state, action, pending] = useActionState(extractExpenseReceiptAction, initial);
  const [confirmState, confirmAction, confirmPending] = useActionState(
    confirmExpenseReceiptDraftAction,
    confirmInitial,
  );
  const [attemptId, setAttemptId] = useState(newAttemptId);

  useEffect(() => {
    if (
      shouldRotateAiAttemptId(state) ||
      state.status === "COMPLETED" ||
      state.status === "LOW_CONFIDENCE"
    ) {
      setAttemptId(newAttemptId());
    }
  }, [state.error, state.inProgress, state.status, state.vendor, state.amount]);

  if (!canExtract) {
    return <p className="text-xs text-muted-foreground">{EXPENSE_RECEIPT_EXTRACT_OWNER_ONLY_MESSAGE}</p>;
  }

  if (!providerConfigured) {
    return (
      <div className="space-y-1">
        <p className="text-sm font-medium">{EXPENSE_RECEIPT_EXTRACT_UNAVAILABLE_MESSAGE}</p>
        <p className="text-xs text-muted-foreground">
          The AI provider is not configured. TBBT did not invent vendor, date, amount, or tax, and
          did not change this expense.
        </p>
      </div>
    );
  }

  if (!storedAssetId) {
    return (
      <p className="text-xs text-muted-foreground">
        Attach a private receipt before requesting extraction.
      </p>
    );
  }

  const confirmable = reviewStatus === "DRAFT" || state.confirmable;

  return (
    <div className="space-y-3">
      <form action={action} className="space-y-3">
        <input type="hidden" name="attemptId" value={attemptId} />
        <input type="hidden" name="storedAssetId" value={storedAssetId} />
        <div className="space-y-1.5">
          <Label htmlFor={`receipt-extract-text-${expenseId}`}>Receipt text</Label>
          <textarea
            id={`receipt-extract-text-${expenseId}`}
            name="receiptText"
            rows={4}
            maxLength={4000}
            placeholder="Paste the receipt lines. TBBT treats this as untrusted text."
            className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? "Extracting…" : "Extract vendor, date, amount, tax"}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        The provider writes a reviewable DRAFT only. It will not overwrite a recorded expense or
        enter reports until you confirm.
      </p>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.status === "UNAVAILABLE" ? (
        <p className="text-sm font-medium">{EXPENSE_RECEIPT_EXTRACT_UNAVAILABLE_MESSAGE}</p>
      ) : null}
      {state.message && state.status !== "UNAVAILABLE" ? (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      ) : null}
      {state.vendor || state.occurredOn || state.amount || state.tax ? (
        <div className="rounded-md border bg-muted/40 p-2 text-sm">
          <p className="text-xs font-medium">Owner-requested draft — review required</p>
          {state.vendor ? <p>Vendor: {state.vendor}</p> : null}
          {state.occurredOn ? <p>Date: {state.occurredOn}</p> : null}
          {state.amount ? <p>Amount: ${state.amount}</p> : null}
          {state.tax ? <p>Tax: ${state.tax}</p> : null}
        </div>
      ) : null}
      {confirmable ? (
        <form action={confirmAction}>
          <input type="hidden" name="expenseId" value={state.expenseId ?? expenseId} />
          <Button type="submit" size="sm" disabled={confirmPending}>
            {confirmPending ? "Confirming…" : "Confirm draft"}
          </Button>
        </form>
      ) : null}
      {confirmState.error ? <p className="text-sm text-destructive">{confirmState.error}</p> : null}
      {confirmState.message ? <p className="text-sm text-emerald-400">{confirmState.message}</p> : null}
    </div>
  );
}

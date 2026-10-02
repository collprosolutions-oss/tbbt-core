"use client";

import { useActionState } from "react";
import {
  importBankCsvAction,
  type BankReconciliationActionState,
} from "@/app/actions/bank-reconciliation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BANK_CREDITS_ARE_NOT_DEPOSITS_MESSAGE,
  BANK_NO_LIVE_FEED_MESSAGE,
  BANK_NOT_A_BALANCE_MESSAGE,
  BANK_NOT_A_PAYMENT_MESSAGE,
  MAX_BANK_CSV_BYTES,
  MAX_BANK_CSV_ROWS,
} from "@/lib/bank-reconciliation-copy";

const initialState: BankReconciliationActionState = {};

export function ImportBankCsvForm() {
  const [state, action, pending] = useActionState(importBankCsvAction, initialState);

  return (
    <form action={action} className="space-y-5">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <p className="text-sm text-muted-foreground">
        {BANK_NO_LIVE_FEED_MESSAGE} {BANK_NOT_A_PAYMENT_MESSAGE} {BANK_NOT_A_BALANCE_MESSAGE}{" "}
        {BANK_CREDITS_ARE_NOT_DEPOSITS_MESSAGE}
      </p>

      <div className="space-y-2">
        <Label htmlFor="csv">Bank CSV</Label>
        <Input
          id="csv"
          name="csv"
          type="file"
          accept=".csv,text/csv,text/plain"
          required
        />
        <p className="text-xs text-muted-foreground">
          Max {MAX_BANK_CSV_BYTES / 1024} KB and {MAX_BANK_CSV_ROWS} data rows. Required:
          date plus amount, debit, or credit. Balance columns are ignored and never treated
          as a verified bank balance.
        </p>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? "Importing for review…" : "Import for review"}
      </Button>
    </form>
  );
}

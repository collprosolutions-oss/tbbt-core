"use client";

import { useActionState } from "react";
import {
  previewCustomerCsvImport,
  type CustomerCsvImportActionState,
} from "@/app/actions/customer-csv-import";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  IMPORT_NO_CONSENT_MESSAGE,
  IMPORT_NO_OUTREACH_MESSAGE,
  IMPORT_NO_OVERWRITE_MESSAGE,
  IMPORT_NO_SCORE_MESSAGE,
  IMPORT_NO_SCRAPE_MESSAGE,
  MAX_CUSTOMER_CSV_IMPORT_BYTES,
  MAX_CUSTOMER_CSV_IMPORT_ROWS,
} from "@/lib/customer-csv-import-copy";

const initialState: CustomerCsvImportActionState = {};

export function ImportCustomersForm() {
  const [state, action, pending] = useActionState(previewCustomerCsvImport, initialState);

  return (
    <form action={action} className="space-y-5">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <p className="text-sm text-muted-foreground">
        {IMPORT_NO_SCRAPE_MESSAGE} {IMPORT_NO_SCORE_MESSAGE} {IMPORT_NO_OVERWRITE_MESSAGE}{" "}
        {IMPORT_NO_CONSENT_MESSAGE} {IMPORT_NO_OUTREACH_MESSAGE} Nothing is created until you
        review the preview, resolve invalid rows, and confirm.
      </p>

      <div className="space-y-2">
        <Label htmlFor="csv">Manual CSV</Label>
        <Input
          id="csv"
          name="csv"
          type="file"
          accept=".csv,text/csv,text/plain"
          required
        />
        <p className="text-xs text-muted-foreground">
          Max {MAX_CUSTOMER_CSV_IMPORT_BYTES / 1024} KB and {MAX_CUSTOMER_CSV_IMPORT_ROWS}{" "}
          data rows. Required column: name. Optional: email, phone, label, street, unit,
          city, region, postal. SMS consent columns are ignored.
        </p>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? "Building preview…" : "Preview import"}
      </Button>
    </form>
  );
}

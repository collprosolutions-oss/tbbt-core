"use client";

import { useActionState } from "react";
import {
  previewServiceCatalogImport,
  type ServiceCatalogImportActionState,
} from "@/app/actions/service-catalog-import";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CATALOG_IMPORT_NAME_MATCH_MESSAGE,
  CATALOG_IMPORT_NO_HISTORY_REWRITE_MESSAGE,
  CATALOG_IMPORT_NO_HOURLY_MESSAGE,
  MAX_SERVICE_CATALOG_IMPORT_BYTES,
  MAX_SERVICE_CATALOG_IMPORT_ROWS,
} from "@/lib/service-catalog-import-copy";

const initialState: ServiceCatalogImportActionState = {};

export function ImportCatalogForm() {
  const [state, action, pending] = useActionState(
    previewServiceCatalogImport,
    initialState,
  );

  return (
    <form action={action} className="space-y-5">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <p className="text-sm text-muted-foreground">
        {CATALOG_IMPORT_NO_HOURLY_MESSAGE} {CATALOG_IMPORT_NAME_MATCH_MESSAGE}{" "}
        {CATALOG_IMPORT_NO_HISTORY_REWRITE_MESSAGE} Nothing is written until you
        review validation errors, name matches, and confirm.
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
          Max {MAX_SERVICE_CATALOG_IMPORT_BYTES / 1024} KB and{" "}
          {MAX_SERVICE_CATALOG_IMPORT_ROWS} data rows. Required column: name.
          pricingMode is required. price is required except for Custom Quote.
          Optional: description, category, tradeCode, unitLabel,
          recurrenceEligible, active. Blank optional cells keep existing values
          on update.
        </p>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? "Building preview…" : "Preview catalog CSV"}
      </Button>
    </form>
  );
}

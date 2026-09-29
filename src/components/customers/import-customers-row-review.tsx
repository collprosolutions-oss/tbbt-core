"use client";

import { useActionState } from "react";
import {
  correctCustomerCsvImportRowAction,
  rejectCustomerCsvImportRowAction,
  type CustomerCsvImportActionState,
} from "@/app/actions/customer-csv-import";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  IMPORT_NO_CONSENT_MESSAGE,
  IMPORT_NO_OUTREACH_MESSAGE,
  previewStatusLabel,
} from "@/lib/customer-csv-import-copy";

const initialState: CustomerCsvImportActionState = {};

export type ImportCustomerReviewRow = {
  id: string;
  rowNumber: number;
  previewStatus: string;
  invalidReason: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  propertyLabel: string | null;
  streetAddress: string | null;
  unit: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
};

function Field({
  id,
  name,
  label,
  defaultValue,
  required,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue: string;
  required?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} defaultValue={defaultValue} required={required} />
    </div>
  );
}

export function ImportCustomerRowReview({
  importId,
  row,
  confirmed,
}: {
  importId: string;
  row: ImportCustomerReviewRow;
  confirmed: boolean;
}) {
  const [correctState, correctAction, correctPending] = useActionState(
    correctCustomerCsvImportRowAction,
    initialState,
  );
  const [rejectState, rejectAction, rejectPending] = useActionState(
    rejectCustomerCsvImportRowAction,
    initialState,
  );
  const pending = correctPending || rejectPending;
  const error = correctState.error ?? rejectState.error;
  const fieldId = (suffix: string) => `customer-import-row-${row.id}-${suffix}`;

  return (
    <article className="space-y-3 rounded-lg border border-border/70 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">
          Row {row.rowNumber} · {previewStatusLabel(row.previewStatus)}
        </h3>
        <p className="text-sm text-muted-foreground">
          {row.invalidReason || previewStatusLabel(row.previewStatus)}
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {confirmed ? (
        <p className="text-sm text-muted-foreground">
          This preview was already confirmed. Staged corrections are closed.
        </p>
      ) : row.previewStatus !== "INVALID" ? (
        <p className="text-sm text-muted-foreground">
          Rejection is final for this preview. This row will not import a customer or
          property.
        </p>
      ) : (
        <>
          <form action={correctAction} className="space-y-3">
            <input type="hidden" name="importId" value={importId} />
            <input type="hidden" name="rowId" value={row.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                id={fieldId("name")}
                name="name"
                label="Name"
                defaultValue={row.name}
                required
              />
              <Field
                id={fieldId("email")}
                name="email"
                label="Email"
                defaultValue={row.email ?? ""}
              />
              <Field
                id={fieldId("phone")}
                name="phone"
                label="Phone"
                defaultValue={row.phone ?? ""}
              />
              <Field
                id={fieldId("label")}
                name="label"
                label="Property label"
                defaultValue={row.propertyLabel ?? ""}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                id={fieldId("street")}
                name="street"
                label="Street"
                defaultValue={row.streetAddress ?? ""}
              />
              <Field
                id={fieldId("unit")}
                name="unit"
                label="Unit"
                defaultValue={row.unit ?? ""}
              />
              <Field
                id={fieldId("city")}
                name="city"
                label="City"
                defaultValue={row.city ?? ""}
              />
              <Field
                id={fieldId("region")}
                name="region"
                label="Region"
                defaultValue={row.region ?? ""}
              />
              <Field
                id={fieldId("postal")}
                name="postal"
                label="Postal"
                defaultValue={row.postalCode ?? ""}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {IMPORT_NO_CONSENT_MESSAGE} {IMPORT_NO_OUTREACH_MESSAGE}
            </p>
            <Button type="submit" size="sm" disabled={pending}>
              {correctPending ? "Saving correction…" : "Save correction"}
            </Button>
          </form>

          {row.previewStatus === "INVALID" ? (
            <form action={rejectAction} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="importId" value={importId} />
              <input type="hidden" name="rowId" value={row.id} />
              <Button type="submit" size="sm" variant="outline" disabled={pending}>
                {rejectPending ? "Rejecting…" : "Reject this row"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Rejection discards the row. It does not send a message or change consent.
              </span>
            </form>
          ) : null}
        </>
      )}
    </article>
  );
}

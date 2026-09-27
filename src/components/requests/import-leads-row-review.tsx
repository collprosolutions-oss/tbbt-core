"use client";

import { useActionState } from "react";
import {
  correctExternalLeadImportRowAction,
  rejectExternalLeadImportRowAction,
  type ExternalLeadImportActionState,
} from "@/app/actions/external-lead-import";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  IMPORT_NO_OUTREACH_MESSAGE,
  previewStatusLabel,
} from "@/lib/external-lead-import-copy";
import { isLeadSource, LEAD_SOURCE_LABELS, LEAD_SOURCES } from "@/lib/lead-attribution";

const initialState: ExternalLeadImportActionState = {};

export type ImportLeadReviewRow = {
  id: string;
  rowNumber: number;
  previewStatus: string;
  invalidReason: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  summary: string | null;
  notes: string | null;
  streetAddress: string | null;
  unit: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  leadSource: string;
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

export function ImportLeadRowReview({
  importId,
  row,
  confirmed,
}: {
  importId: string;
  row: ImportLeadReviewRow;
  confirmed: boolean;
}) {
  const [correctState, correctAction, correctPending] = useActionState(
    correctExternalLeadImportRowAction,
    initialState,
  );
  const [rejectState, rejectAction, rejectPending] = useActionState(
    rejectExternalLeadImportRowAction,
    initialState,
  );
  const pending = correctPending || rejectPending;
  const error = correctState.error ?? rejectState.error;
  const fieldId = (suffix: string) => `import-row-${row.id}-${suffix}`;

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
                id={fieldId("summary")}
                name="summary"
                label="Summary"
                defaultValue={row.summary ?? ""}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={fieldId("notes")}>Notes</Label>
              <textarea
                id={fieldId("notes")}
                name="notes"
                rows={3}
                defaultValue={row.notes ?? ""}
                className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
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
              <div className="space-y-1">
                <Label htmlFor={fieldId("source")}>Source</Label>
                <select
                  id={fieldId("source")}
                  name="source"
                  defaultValue={isLeadSource(row.leadSource) ? row.leadSource : "MANUAL"}
                  className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm"
                >
                  {LEAD_SOURCES.map((source) => (
                    <option key={source} value={source}>
                      {LEAD_SOURCE_LABELS[source]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{IMPORT_NO_OUTREACH_MESSAGE}</p>
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
                Rejection discards the row. It does not send a message.
              </span>
            </form>
          ) : null}
        </>
      )}
    </article>
  );
}

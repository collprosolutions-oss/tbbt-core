"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  confirmCustomerCsvImportAction,
  type CustomerCsvImportActionState,
} from "@/app/actions/customer-csv-import";
import {
  ImportCustomerRowReview,
  type ImportCustomerReviewRow,
} from "@/components/customers/import-customers-row-review";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  IMPORT_CONFIRM_REQUIRED_MESSAGE,
  IMPORT_NO_CONSENT_MESSAGE,
  IMPORT_NO_OUTREACH_MESSAGE,
  IMPORT_NO_OVERWRITE_MESSAGE,
  IMPORT_NO_SCORE_MESSAGE,
  IMPORT_RESOLVE_INVALID_MESSAGE,
  previewStatusLabel,
  sourceKindLabel,
} from "@/lib/customer-csv-import-copy";

const initialState: CustomerCsvImportActionState = {};

export type ImportCustomerPreviewRow = ImportCustomerReviewRow & {
  possibleDuplicateCustomerId: string | null;
  createdCustomerId: string | null;
  createdPropertyId: string | null;
  reusedExistingCustomer: boolean;
};

export function ImportCustomersPreview({
  importId,
  sourceKind,
  sourceLabel,
  capturedAtLabel,
  status,
  validCount,
  invalidCount,
  possibleDuplicateCount,
  rejectedCount,
  createdCount,
  reusedCount,
  rows,
}: {
  importId: string;
  sourceKind: string;
  sourceLabel: string;
  capturedAtLabel: string;
  status: string;
  validCount: number;
  invalidCount: number;
  possibleDuplicateCount: number;
  rejectedCount: number;
  createdCount: number;
  reusedCount: number;
  rows: ImportCustomerPreviewRow[];
}) {
  const [state, action, pending] = useActionState(
    confirmCustomerCsvImportAction,
    initialState,
  );
  const confirmed = status === "CONFIRMED";
  const invalidRows = rows.filter((row) => row.previewStatus === "INVALID");
  const rejectedRows = rows.filter((row) => row.previewStatus === "REJECTED");
  const duplicateRows = rows.filter((row) => row.previewStatus === "POSSIBLE_DUPLICATE");
  const validRows = rows.filter((row) => row.previewStatus === "VALID");
  const confirmableCount = validCount + possibleDuplicateCount;

  return (
    <div className="space-y-6">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <dl className="grid gap-3 rounded-lg border border-border/70 bg-card p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Source</dt>
          <dd className="font-medium">
            {sourceKindLabel(sourceKind)} — {sourceLabel}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Captured</dt>
          <dd className="font-medium">{capturedAtLabel}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Ready</dt>
          <dd className="font-medium">{validCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Invalid</dt>
          <dd className="font-medium">{invalidCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Possible same-business duplicates</dt>
          <dd className="font-medium">{possibleDuplicateCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Rejected</dt>
          <dd className="font-medium">{rejectedCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Created customers</dt>
          <dd className="font-medium">{createdCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Attached to existing customers</dt>
          <dd className="font-medium">{reusedCount}</dd>
        </div>
      </dl>

      <p className="text-sm text-muted-foreground">
        {IMPORT_NO_SCORE_MESSAGE} {IMPORT_NO_OVERWRITE_MESSAGE} {IMPORT_NO_CONSENT_MESSAGE}{" "}
        {IMPORT_NO_OUTREACH_MESSAGE}{" "}
        {confirmed
          ? "This preview was already confirmed."
          : invalidCount > 0
            ? IMPORT_RESOLVE_INVALID_MESSAGE
            : IMPORT_CONFIRM_REQUIRED_MESSAGE}
      </p>

      <PreviewTable title="Ready rows" rows={validRows} />
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Invalid rows</h2>
        {invalidRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          invalidRows.map((row) => (
            <ImportCustomerRowReview
              key={row.id}
              importId={importId}
              row={row}
              confirmed={confirmed}
            />
          ))
        )}
      </section>
      <PreviewTable title="Possible same-business duplicates" rows={duplicateRows} />
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Rejected rows</h2>
        {rejectedRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          rejectedRows.map((row) => (
            <article
              key={row.id}
              className="space-y-1 rounded-lg border border-border/70 p-4 text-sm"
            >
              <h3 className="font-semibold">
                Row {row.rowNumber} · {previewStatusLabel(row.previewStatus)}
              </h3>
              <p className="text-muted-foreground">
                {row.invalidReason || previewStatusLabel(row.previewStatus)}
              </p>
              <p>
                {[row.name, row.email, row.phone].filter(Boolean).join(" · ") ||
                  "No captured fields."}
              </p>
              <p className="text-xs text-muted-foreground">
                Rejection is final for this preview. This row will not import a customer
                or property.
              </p>
            </article>
          ))
        )}
      </section>

      {confirmed ? (
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link href="/customers">Open customers</Link>
          </Button>
        </div>
      ) : (
        <form action={action} className="space-y-3 rounded-lg border border-border/70 p-4">
          <input type="hidden" name="importId" value={importId} />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="includePossibleDuplicates" value="yes" />
            <span>
              Also attach properties for the possible same-business duplicates listed
              above. Existing customers and SMS consent are never overwritten. Rejected
              rows are never imported.
            </span>
          </label>
          <Button
            type="submit"
            disabled={pending || invalidCount > 0 || confirmableCount === 0}
          >
            {pending ? "Importing customers…" : "Confirm and import customers"}
          </Button>
        </form>
      )}
    </div>
  );
}

function PreviewTable({
  title,
  rows,
}: {
  title: string;
  rows: ImportCustomerPreviewRow[];
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/70">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Row</th>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Contact</th>
                <th className="px-3 py-2 font-medium">Property</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border/60">
                  <td className="px-3 py-2 tabular-nums">{row.rowNumber}</td>
                  <td className="px-3 py-2">{row.name || "—"}</td>
                  <td className="px-3 py-2">
                    {[row.email, row.phone].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td className="px-3 py-2">
                    {[row.streetAddress, row.city, row.region, row.postalCode]
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </td>
                  <td className="px-3 py-2">
                    {row.createdCustomerId ? (
                      <Link
                        href={`/customers/${row.createdCustomerId}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {row.reusedExistingCustomer
                          ? "Attached to existing customer"
                          : "Created customer"}
                      </Link>
                    ) : row.invalidReason ? (
                      row.invalidReason
                    ) : (
                      previewStatusLabel(row.previewStatus)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

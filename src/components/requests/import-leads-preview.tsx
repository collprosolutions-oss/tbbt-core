"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  confirmExternalLeadImportAction,
  type ExternalLeadImportActionState,
} from "@/app/actions/external-lead-import";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  IMPORT_CONFIRM_REQUIRED_MESSAGE,
  IMPORT_NO_OUTREACH_MESSAGE,
  IMPORT_NO_SCORE_MESSAGE,
  previewStatusLabel,
  sourceKindLabel,
} from "@/lib/external-lead-import";

const initialState: ExternalLeadImportActionState = {};

export type ImportLeadPreviewRow = {
  id: string;
  rowNumber: number;
  previewStatus: string;
  invalidReason: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  summary: string | null;
  possibleDuplicateCustomerId: string | null;
  possibleDuplicateRequestId: string | null;
  createdRequestId: string | null;
};

export function ImportLeadsPreview({
  importId,
  sourceKind,
  sourceLabel,
  capturedAtLabel,
  status,
  validCount,
  invalidCount,
  possibleDuplicateCount,
  createdCount,
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
  createdCount: number;
  rows: ImportLeadPreviewRow[];
}) {
  const [state, action, pending] = useActionState(
    confirmExternalLeadImportAction,
    initialState,
  );
  const confirmed = status === "CONFIRMED";
  const invalidRows = rows.filter((row) => row.previewStatus === "INVALID");
  const duplicateRows = rows.filter((row) => row.previewStatus === "POSSIBLE_DUPLICATE");
  const validRows = rows.filter((row) => row.previewStatus === "VALID");

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
          <dt className="text-muted-foreground">Created requests</dt>
          <dd className="font-medium">{createdCount}</dd>
        </div>
      </dl>

      <p className="text-sm text-muted-foreground">
        {IMPORT_NO_SCORE_MESSAGE} {IMPORT_NO_OUTREACH_MESSAGE}{" "}
        {confirmed ? "This preview was already confirmed." : IMPORT_CONFIRM_REQUIRED_MESSAGE}
      </p>

      <PreviewTable title="Ready rows" rows={validRows} />
      <PreviewTable title="Invalid rows" rows={invalidRows} />
      <PreviewTable title="Possible same-business duplicates" rows={duplicateRows} />

      {confirmed ? (
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link href="/requests">Open requests</Link>
          </Button>
        </div>
      ) : (
        <form action={action} className="space-y-3 rounded-lg border border-border/70 p-4">
          <input type="hidden" name="importId" value={importId} />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="includePossibleDuplicates" value="yes" />
            <span>
              Also create the possible same-business duplicates listed above. Invalid rows
              are never created.
            </span>
          </label>
          <Button type="submit" disabled={pending || validCount + possibleDuplicateCount === 0}>
            {pending ? "Creating leads…" : "Confirm and create leads"}
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
  rows: ImportLeadPreviewRow[];
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
                <th className="px-3 py-2 font-medium">Summary</th>
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
                  <td className="px-3 py-2">{row.summary || "—"}</td>
                  <td className="px-3 py-2">
                    {row.createdRequestId ? (
                      <Link
                        href={`/requests?selected=${row.createdRequestId}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        Created request
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

"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  confirmServiceCatalogImportAction,
  type ServiceCatalogImportActionState,
} from "@/app/actions/service-catalog-import";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  CATALOG_IMPORT_CONFIRM_REQUIRED_MESSAGE,
  CATALOG_IMPORT_NAME_MATCH_MESSAGE,
  CATALOG_IMPORT_NO_HISTORY_REWRITE_MESSAGE,
  CATALOG_IMPORT_NO_HOURLY_MESSAGE,
  CATALOG_IMPORT_RESOLVE_INVALID_MESSAGE,
  SERVICE_CATALOG_IMPORT_ROUTE,
  catalogImportPreviewStatusLabel,
  catalogImportSourceKindLabel,
} from "@/lib/service-catalog-import-copy";

const initialState: ServiceCatalogImportActionState = {};

export type CatalogImportPreviewRow = {
  id: string;
  rowNumber: number;
  previewStatus: string;
  invalidReason: string | null;
  name: string;
  description: string | null;
  pricingMode: string;
  price: string;
  category: string;
  tradeCode: string;
  unitLabel: string;
  recurrenceEligible: boolean;
  active: boolean;
  matchedCatalogItemId: string | null;
  writtenCatalogItemId: string | null;
  writeAction: string | null;
};

export function ImportCatalogPreview({
  importId,
  sourceKind,
  sourceLabel,
  capturedAtLabel,
  status,
  validCount,
  invalidCount,
  nameMatchCount,
  writtenCount,
  rows,
}: {
  importId: string;
  sourceKind: string;
  sourceLabel: string;
  capturedAtLabel: string;
  status: string;
  validCount: number;
  invalidCount: number;
  nameMatchCount: number;
  writtenCount: number;
  rows: CatalogImportPreviewRow[];
}) {
  const [state, action, pending] = useActionState(
    confirmServiceCatalogImportAction,
    initialState,
  );
  const confirmed = status === "CONFIRMED";
  const invalidRows = rows.filter((row) => row.previewStatus === "INVALID");
  const matchRows = rows.filter((row) => row.previewStatus === "NAME_MATCH");
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
            {catalogImportSourceKindLabel(sourceKind)} — {sourceLabel}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Captured</dt>
          <dd className="font-medium">{capturedAtLabel}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Ready to add</dt>
          <dd className="font-medium">{validCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Name matches (will update)</dt>
          <dd className="font-medium">{nameMatchCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Invalid</dt>
          <dd className="font-medium">{invalidCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Written catalog services</dt>
          <dd className="font-medium">{writtenCount}</dd>
        </div>
      </dl>

      <p className="text-sm text-muted-foreground">
        {CATALOG_IMPORT_NO_HOURLY_MESSAGE} {CATALOG_IMPORT_NAME_MATCH_MESSAGE}{" "}
        {CATALOG_IMPORT_NO_HISTORY_REWRITE_MESSAGE}{" "}
        {confirmed
          ? "This preview was already confirmed."
          : invalidCount > 0
            ? CATALOG_IMPORT_RESOLVE_INVALID_MESSAGE
            : CATALOG_IMPORT_CONFIRM_REQUIRED_MESSAGE}
      </p>

      <PreviewTable title="Ready to add" rows={validRows} />
      <PreviewTable title="Duplicate-name matches" rows={matchRows} />
      <PreviewTable title="Validation errors" rows={invalidRows} />

      {confirmed ? (
        <Button asChild>
          <Link href="/services">Back to Services</Link>
        </Button>
      ) : (
        <form action={action} className="space-y-3">
          <input type="hidden" name="importId" value={importId} />
          <Button type="submit" disabled={pending || invalidCount > 0}>
            {pending
              ? "Writing catalog…"
              : "Confirm add and update"}
          </Button>
          <p className="text-xs text-muted-foreground">
            <Link href={SERVICE_CATALOG_IMPORT_ROUTE} className="underline">
              Upload a different CSV
            </Link>
          </p>
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
  rows: CatalogImportPreviewRow[];
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/70">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Row</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Trade</th>
                <th className="px-3 py-2 font-medium">Pricing</th>
                <th className="px-3 py-2 font-medium">Price</th>
                <th className="px-3 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border/60">
                  <td className="px-3 py-2">{row.rowNumber}</td>
                  <td className="px-3 py-2">
                    {catalogImportPreviewStatusLabel(row.previewStatus)}
                  </td>
                  <td className="px-3 py-2 font-medium">{row.name}</td>
                  <td className="px-3 py-2">{row.tradeCode}</td>
                  <td className="px-3 py-2">{row.pricingMode}</td>
                  <td className="px-3 py-2">{row.price || "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {row.invalidReason ||
                      (row.matchedCatalogItemId
                        ? "Matches an existing service on this business."
                        : row.writeAction
                          ? row.writeAction === "UPDATE"
                            ? "Updated."
                            : "Added."
                          : row.category)}
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

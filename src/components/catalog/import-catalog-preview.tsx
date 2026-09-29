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
  CATALOG_IMPORT_IN_PROGRESS_MESSAGE,
  CATALOG_IMPORT_INTERRUPTED_MESSAGE,
  CATALOG_IMPORT_NAME_MATCH_MESSAGE,
  CATALOG_IMPORT_NO_HISTORY_REWRITE_MESSAGE,
  CATALOG_IMPORT_NO_HOURLY_MESSAGE,
  CATALOG_IMPORT_RESOLVE_INVALID_MESSAGE,
  SERVICE_CATALOG_IMPORT_ROUTE,
  catalogImportMatchDecisionLabel,
  catalogImportPreviewStatusLabel,
  catalogImportSourceKindLabel,
} from "@/lib/service-catalog-import-copy";

const initialState: ServiceCatalogImportActionState = {};

export type CatalogImportMatchedCurrent = {
  id: string;
  name: string;
  description: string | null;
  pricingMode: string;
  price: string;
  category: string;
  active: boolean;
};

export type CatalogImportPreviewRow = {
  id: string;
  rowNumber: number;
  previewStatus: string;
  invalidReason: string | null;
  name: string;
  description: string | null;
  pricingMode: string;
  price: string;
  category: string | null;
  tradeCode: string;
  unitLabel: string;
  recurrenceEligible: boolean | null;
  active: boolean | null;
  matchedCatalogItemId: string | null;
  writtenCatalogItemId: string | null;
  writeAction: string | null;
  matchDecision: string;
  current: CatalogImportMatchedCurrent | null;
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
  confirmingRecoverable = false,
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
  confirmingRecoverable?: boolean;
  rows: CatalogImportPreviewRow[];
}) {
  const [state, action, pending] = useActionState(
    confirmServiceCatalogImportAction,
    initialState,
  );
  const confirmed = status === "CONFIRMED";
  const confirming = status === "CONFIRMING";
  const inProgress = confirming && !confirmingRecoverable;
  const canConfirm = !confirmed && !inProgress;
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
          <dt className="text-muted-foreground">
            Name matches (change only if you pick update)
          </dt>
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
          : confirmingRecoverable
            ? CATALOG_IMPORT_INTERRUPTED_MESSAGE
            : inProgress
              ? CATALOG_IMPORT_IN_PROGRESS_MESSAGE
              : invalidCount > 0
                ? CATALOG_IMPORT_RESOLVE_INVALID_MESSAGE
                : CATALOG_IMPORT_CONFIRM_REQUIRED_MESSAGE}
      </p>

      <PreviewTable title="Ready to add" rows={validRows} />
      {canConfirm ? (
        <form action={action} className="space-y-6">
          <input type="hidden" name="importId" value={importId} />
          <MatchTable rows={matchRows} confirmed={false} />
          <PreviewTable title="Validation errors" rows={invalidRows} />
          <div className="space-y-3">
            <Button type="submit" disabled={pending || invalidCount > 0}>
              {pending ? "Writing catalog…" : "Confirm catalog changes"}
            </Button>
            <p className="text-xs text-muted-foreground">
              <Link href={SERVICE_CATALOG_IMPORT_ROUTE} className="underline">
                Upload a different CSV
              </Link>
            </p>
          </div>
        </form>
      ) : (
        <>
          <MatchTable rows={matchRows} confirmed={confirmed} />
          <PreviewTable title="Validation errors" rows={invalidRows} />
          {confirmed ? (
            <Button asChild>
              <Link href="/services">Back to Services</Link>
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              <Link href={SERVICE_CATALOG_IMPORT_ROUTE} className="underline">
                Upload a different CSV
              </Link>
            </p>
          )}
        </>
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
                      (row.writeAction
                        ? row.writeAction === "UPDATE"
                          ? "Updated."
                          : "Added."
                        : row.category || "—")}
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

function MatchTable({
  rows,
  confirmed,
}: {
  rows: CatalogImportPreviewRow[];
  confirmed: boolean;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">Duplicate-name matches</h2>
      <p className="text-sm text-muted-foreground">
        Skip is the default. Matched services change only when you pick update.
        Blank incoming cells keep the existing description, category, recurrence,
        unit label, and active status. A blank active cell never reactivates an
        archived service.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        <div className="space-y-4">
          {rows.map((row) => (
            <article
              key={row.id}
              className="space-y-3 rounded-lg border border-border/70 p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium">
                  Row {row.rowNumber}: {row.name}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {row.tradeCode}
                  {confirmed
                    ? ` · ${
                        row.writeAction
                          ? row.writeAction === "UPDATE"
                            ? "Updated."
                            : "Added."
                          : catalogImportMatchDecisionLabel(row.matchDecision)
                      }`
                    : null}
                </p>
              </div>
              <ComparisonTable row={row} />
              {confirmed ? null : (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">
                    What should happen to this matching service?
                  </legend>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name={`matchDecision:${row.rowNumber}`}
                      value="SKIP"
                      defaultChecked={
                        row.matchDecision !== "UPDATE" &&
                        row.matchDecision !== "ADD_NEW"
                      }
                    />
                    <span>Skip — leave the current service unchanged</span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name={`matchDecision:${row.rowNumber}`}
                      value="UPDATE"
                      defaultChecked={row.matchDecision === "UPDATE"}
                    />
                    <span>Update the matching service</span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name={`matchDecision:${row.rowNumber}`}
                      value="ADD_NEW"
                      defaultChecked={row.matchDecision === "ADD_NEW"}
                    />
                    <span>Add as a new service</span>
                  </label>
                </fieldset>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function ComparisonTable({ row }: { row: CatalogImportPreviewRow }) {
  const current = row.current;
  const rows = [
    ["Price", current?.price || "—", incomingText(row.price, false)],
    ["Pricing mode", current?.pricingMode || "—", incomingText(row.pricingMode, false)],
    [
      "Description",
      current?.description || "—",
      incomingText(row.description, true),
    ],
    ["Category", current?.category || "—", incomingText(row.category, true)],
    [
      "Active",
      current ? (current.active ? "Yes" : "No (archived)") : "—",
      incomingBool(row.active),
    ],
  ] as const;

  return (
    <div className="overflow-x-auto rounded-md border border-border/60">
      <table className="w-full min-w-[28rem] text-left text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Field</th>
            <th className="px-3 py-2 font-medium">Current</th>
            <th className="px-3 py-2 font-medium">Incoming</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([field, currentValue, incoming]) => (
            <tr key={field} className="border-t border-border/60">
              <td className="px-3 py-2 text-muted-foreground">{field}</td>
              <td className="px-3 py-2">{currentValue}</td>
              <td className="px-3 py-2">{incoming}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function incomingText(value: string | null | undefined, blankKeepsExisting: boolean) {
  const text = value?.trim() ?? "";
  if (text) return text;
  return blankKeepsExisting ? "Keep existing" : "—";
}

function incomingBool(value: boolean | null) {
  if (value == null) return "Keep existing";
  return value ? "Yes" : "No (archived)";
}

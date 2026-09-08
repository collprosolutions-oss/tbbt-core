"use client";

import { useActionState } from "react";
import {
  applyEstimateCurrentSupplierPrice,
  refreshBusinessSupplierPrices,
  type MaterialPricingActionState,
} from "@/app/actions/material-pricing";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";
import { applyCurrentSupplierPriceToDraftItem } from "@/lib/material-pricing/apply";
import { buildOwnerSupplierPricingBoard } from "@/lib/material-pricing/engine";
import type { SupplierPricingContextPayload } from "@/lib/material-pricing/types";
import type { TakeoffSnapshot } from "@/lib/material-takeoff/types";

const initialState: MaterialPricingActionState = {};

export function SupplierPricingPanel({
  estimateId,
  lineItemId,
  takeoffJson,
  draft,
  onApplyLocal,
  context,
  isDraft,
}: {
  estimateId: string;
  lineItemId?: string;
  takeoffJson: string;
  draft: TakeoffSnapshot;
  onApplyLocal: (itemId: string, cost: number) => void;
  context: SupplierPricingContextPayload | null;
  isDraft: boolean;
}) {
  const [applyState, applyAction, applyPending] = useActionState(
    applyEstimateCurrentSupplierPrice,
    initialState,
  );
  const [refreshState, refreshAction, refreshPending] = useActionState(
    refreshBusinessSupplierPrices,
    initialState,
  );

  if (!context) return null;

  const board = buildOwnerSupplierPricingBoard({
    snapshot: draft,
    providerId: context.providerId,
    providerName: context.providerName,
    implemented: context.implemented,
    liveApiAvailable: context.liveApiAvailable,
    limitation: context.limitation,
    locationZip: context.locationZip,
    locationLabel: context.locationLabel,
    preferredEnabled: context.preferredEnabled,
    mappings: context.mappings,
    prices: context.prices.map((row) => ({
      ...row,
      fetchedAt: row.fetchedAt,
    })),
  });

  const mappedCount = board.rows.filter((row) => row.mappingStatus === "mapped").length;
  const unmappedCount = board.rows.filter((row) => row.mappingStatus === "unmapped").length;
  const openByDefault = draft.takeoffType === "concrete-slab";

  return (
    <details
      open={openByDefault}
      className="rounded-lg border border-border/70 bg-muted/10 p-3"
    >
      <summary className="cursor-pointer text-sm font-medium">
        Supplier pricing
        <span className="ml-2 font-normal text-muted-foreground">
          {board.providerName}
          {mappedCount > 0 ? ` · ${mappedCount} mapped` : ""}
          {unmappedCount > 0 ? ` · ${unmappedCount} unmapped` : ""}
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">{board.limitation}</p>
        <p className="text-xs text-muted-foreground">
          Location: {board.locationLabel || "Not set"}
          {board.locationZip ? ` · ${board.locationZip}` : ""}. One preferred
          supplier/location per business — not multi-store shopping.
        </p>
        {!board.liveApiAvailable ? (
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Live supplier API is not connected. Refresh stores a catalog
            reference or last owner-confirmed check. It does not rewrite this
            draft unless you click Use current price.
          </p>
        ) : null}

        {applyState.error || refreshState.error ? (
          <Alert variant="destructive">
            <AlertDescription>
              {applyState.error || refreshState.error}
            </AlertDescription>
          </Alert>
        ) : null}
        {applyState.message || refreshState.message ? (
          <p className="text-xs text-muted-foreground">
            {applyState.message || refreshState.message}
          </p>
        ) : null}

        {isDraft ? (
          <form action={refreshAction}>
            <input type="hidden" name="estimateId" value={estimateId} />
            <input type="hidden" name="providerId" value={board.providerId} />
            <Button type="submit" variant="outline" size="sm" disabled={refreshPending}>
              {refreshPending ? "Refreshing…" : "Refresh supplier prices"}
            </Button>
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">
            Sent and approved estimates stay frozen. Supplier prices cannot
            change this record.
          </p>
        )}

        {board.rows.length > 0 ? (
          <ul className="space-y-2">
            {board.rows.map((row) => (
              <li
                key={row.itemId}
                className="rounded-md border border-border/60 bg-background px-3 py-2 text-xs"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{row.label}</p>
                  <p className="text-muted-foreground">
                    {row.mappingStatus === "not-a-product"
                      ? "Not a supplier product"
                      : row.mappingStatus === "mapped"
                        ? `Mapped · ${row.freshnessLabel}`
                        : `Unmapped · ${row.freshnessLabel}`}
                  </p>
                </div>
                {row.mappingStatus !== "not-a-product" ? (
                  <div className="mt-1 space-y-1 text-muted-foreground">
                    <p>
                      Saved cost:{" "}
                      {row.savedUnitCost != null
                        ? formatMoney(row.savedUnitCost)
                        : "—"}
                    </p>
                    <p>
                      Current supplier price:{" "}
                      {row.supplierUnitCost != null
                        ? formatMoney(row.supplierUnitCost)
                        : "Unavailable"}
                      {row.supplierProductName ? ` · ${row.supplierProductName}` : ""}
                    </p>
                    <p>{row.checkedLabel}</p>
                  </div>
                ) : (
                  <p className="mt-1 text-muted-foreground">
                    Pickup/procurement is an allowance, not a store SKU.
                  </p>
                )}
                {isDraft && row.canUseCurrentPrice ? (
                  <form
                    className="mt-2"
                    action={applyAction}
                    onSubmit={() => {
                      if (row.supplierUnitCost != null) {
                        onApplyLocal(row.itemId, row.supplierUnitCost);
                      }
                    }}
                  >
                    <input type="hidden" name="estimateId" value={estimateId} />
                    {lineItemId ? (
                      <input type="hidden" name="lineItemId" value={lineItemId} />
                    ) : null}
                    <input type="hidden" name="itemId" value={row.itemId} />
                    <input type="hidden" name="takeoffJson" value={takeoffJson} />
                    {row.supplierUnitCost != null ? (
                      <input
                        type="hidden"
                        name="supplierUnitCost"
                        value={String(row.supplierUnitCost)}
                      />
                    ) : null}
                    <Button type="submit" size="sm" disabled={applyPending}>
                      Use current price
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            Calculate the takeoff to see supplier mapping status for each
            material.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Use current price updates this draft’s internal unit cost only.
          Markup still calculates customer selling price. Save as business
          default stays a separate action.{" "}
          <a className="underline" href="/settings?section=vendors">
            Supplier location settings
          </a>
        </p>
      </div>
    </details>
  );
}

export function applySupplierPriceLocally(
  snapshot: TakeoffSnapshot,
  itemId: string,
  cost: number,
) {
  return applyCurrentSupplierPriceToDraftItem(snapshot, itemId, cost);
}

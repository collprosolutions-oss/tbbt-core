"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  refreshBusinessSupplierPrices,
  saveBusinessSupplierPricingSettings,
  type MaterialPricingActionState,
} from "@/app/actions/material-pricing";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/format";
import {
  DEFAULT_SUPPLIER_PROVIDER_ID,
  SUPPLIER_PROVIDER_LABELS,
  type SupplierPricingContextPayload,
} from "@/lib/material-pricing/types";
import { listSupplierProviders } from "@/lib/material-pricing/registry";

const initialState: MaterialPricingActionState = {};

export function SupplierPricingSettingsForm({
  context,
  canEdit,
}: {
  context: SupplierPricingContextPayload;
  canEdit: boolean;
}) {
  const [saveState, saveAction, savePending] = useActionState(
    saveBusinessSupplierPricingSettings,
    initialState,
  );
  const [refreshState, refreshAction, refreshPending] = useActionState(
    refreshBusinessSupplierPrices,
    initialState,
  );
  const providers = listSupplierProviders();

  return (
    <div className="space-y-4">
      {saveState.error || refreshState.error ? (
        <Alert variant="destructive">
          <AlertDescription>{saveState.error || refreshState.error}</AlertDescription>
        </Alert>
      ) : null}
      {saveState.message || refreshState.message ? (
        <Alert>
          <AlertDescription>{saveState.message || refreshState.message}</AlertDescription>
        </Alert>
      ) : null}

      <p className="text-sm text-muted-foreground">{context.limitation}</p>
      <p className="text-sm text-muted-foreground">
        This is pricing foundation only — not purchasing, checkout, delivery,
        or multi-store comparison. Business defaults stay separate from current
        supplier prices.
      </p>

      {canEdit ? (
        <form action={saveAction} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="providerId">Preferred supplier</Label>
            <select
              id="providerId"
              name="providerId"
              defaultValue={context.providerId || DEFAULT_SUPPLIER_PROVIDER_ID}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id} disabled={!provider.implemented}>
                  {SUPPLIER_PROVIDER_LABELS[provider.id]}
                  {provider.implemented ? "" : " (not connected)"}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="locationZip">Store ZIP</Label>
              <Input
                id="locationZip"
                name="locationZip"
                defaultValue={context.locationZip ?? ""}
                placeholder="33901"
                inputMode="numeric"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="locationLabel">Location label</Label>
              <Input
                id="locationLabel"
                name="locationLabel"
                defaultValue={context.locationLabel ?? ""}
                placeholder="Fort Myers, FL"
              />
            </div>
          </div>
          <Button type="submit" disabled={savePending}>
            {savePending ? "Saving…" : "Save supplier location"}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only the owner or admin can change the preferred supplier location.
        </p>
      )}

      <form action={refreshAction}>
        <input type="hidden" name="providerId" value={context.providerId} />
        <Button type="submit" variant="outline" disabled={!canEdit || refreshPending}>
          {refreshPending ? "Refreshing…" : "Refresh supplier prices"}
        </Button>
      </form>

      <div className="space-y-2">
        <p className="text-sm font-medium">Concrete slab mappings</p>
        {context.mappings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No mappings saved yet. Save the supplier location or refresh prices
            to seed Home Depot catalog mappings for standard concrete items.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {context.mappings.map((mapping) => {
              const price = context.prices.find(
                (row) => row.providerProductId === mapping.providerProductId,
              );
              return (
                <li
                  key={`${mapping.providerId}-${mapping.materialIdentity}`}
                  className="rounded-lg border p-3"
                >
                  <p className="font-medium">{mapping.productName}</p>
                  <p className="text-xs text-muted-foreground">
                    Identity: {mapping.materialIdentity} · {mapping.unitLabel}
                    {price
                      ? ` · ${formatMoney(price.currentPrice)} (${price.sourceMode})`
                      : " · no stored price yet"}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Button asChild variant="outline">
        <Link href="/estimates">Open Estimates</Link>
      </Button>
    </div>
  );
}

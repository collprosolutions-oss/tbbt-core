"use client";

import { useActionState, useMemo, useState } from "react";
import {
  addCatalogLineItem,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: EstimateActionState = {};

type CatalogOption = {
  id: string;
  name: string;
  pricingMode: string;
  priceLabel: string;
};

export function AddCatalogLineForm({
  estimateId,
  items,
}: {
  estimateId: string;
  items: CatalogOption[];
}) {
  const [state, action, pending] = useActionState(addCatalogLineItem, initialState);
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? "");
  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? items[0],
    [items, selectedId],
  );
  const needsJobPrice = selected?.pricingMode === "CUSTOM_QUOTE";

  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No active catalog items in this workspace.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <input type="hidden" name="estimateId" value={estimateId} />
      <div className="space-y-2">
        <Label htmlFor="catalogItemId">Service</Label>
        <select
          id="catalogItemId"
          name="catalogItemId"
          required
          value={selectedId}
          onChange={(event) => setSelectedId(event.target.value)}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} — {item.priceLabel}
            </option>
          ))}
        </select>
      </div>
      {needsJobPrice ? (
        <div className="space-y-2">
          <Label htmlFor="catalog-unitPrice">Price for this job</Label>
          <Input
            id="catalog-unitPrice"
            name="unitPrice"
            inputMode="decimal"
            required
          />
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="catalog-quantity">Quantity</Label>
        <Input
          id="catalog-quantity"
          name="quantity"
          inputMode="decimal"
          defaultValue="1"
          required
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add catalog item"}
      </Button>
    </form>
  );
}

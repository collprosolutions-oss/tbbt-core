"use client";

import { useActionState, useState } from "react";
import {
  createServiceCatalogItem,
  type CatalogActionState,
} from "@/app/actions/catalog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEFAULT_SERVICE_CATEGORY } from "@/lib/service-catalog-category";

const initialState: CatalogActionState = {};

export function CreateCatalogItemForm({
  categories,
}: {
  categories: string[];
}) {
  const [state, action, pending] = useActionState(
    createServiceCatalogItem,
    initialState,
  );
  const [mode, setMode] = useState("STARTING_AT");

  return (
    <form action={action} className="space-y-3">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="category">Category</Label>
        <Input
          id="category"
          name="category"
          list="catalog-category-options"
          defaultValue={DEFAULT_SERVICE_CATEGORY}
        />
        <datalist id="catalog-category-options">
          {categories.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>
      </div>
      <div className="space-y-2">
        <Label htmlFor="pricingMode">Pricing mode</Label>
        <select
          id="pricingMode"
          name="pricingMode"
          value={mode}
          onChange={(event) => setMode(event.target.value)}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          <option value="STARTING_AT">Starting at</option>
          <option value="FIXED">Fixed</option>
          <option value="CUSTOM_QUOTE">Custom Quote</option>
        </select>
      </div>
      {mode === "CUSTOM_QUOTE" ? null : (
        <div className="space-y-2">
          <Label htmlFor="price">Price</Label>
          <Input id="price" name="price" inputMode="decimal" required />
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="description">Description (optional)</Label>
        <textarea
          id="description"
          name="description"
          rows={4}
          className="min-h-20 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none md:text-sm"
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Add service"}
      </Button>
    </form>
  );
}

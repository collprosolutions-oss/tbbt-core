"use client";

import { useActionState, useState } from "react";
import {
  deleteServiceCatalogItem,
  setServiceCatalogItemActive,
  updateServiceCatalogItem,
  type CatalogActionState,
} from "@/app/actions/catalog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEFAULT_SERVICE_CATEGORY } from "@/lib/service-catalog-category";
import { WritingAssistBar } from "@/components/ai/writing-assist-bar";

const initialState: CatalogActionState = {};

export const DEACTIVATE_CATALOG_ITEM_CONFIRM =
  "Deactivate this catalog service?\n\nIt will no longer appear on the public request page or when adding services to new estimates. Existing estimates, jobs, and invoices keep their recorded line items and prices. You can reactivate it later.";

export const REACTIVATE_CATALOG_ITEM_CONFIRM =
  "Reactivate this catalog service?\n\nIt will appear again on the public request page and when adding services to new estimates. Existing estimates stay unchanged.";

export const DELETE_CATALOG_ITEM_CONFIRM =
  "Delete this catalog service?\n\nIt will no longer appear on the public request page or when adding services to new estimates.\n\nExisting estimates, jobs, and invoices keep their recorded line items and prices. Historical snapshots are not changed.\n\nThis cannot be undone from here. Prefer Deactivate if you may need the service later.";

type CatalogItemRowProps = {
  id: string;
  name: string;
  pricingMode: string;
  price: string;
  displayPrice: string;
  description: string;
  category: string;
  categories: string[];
  active: boolean;
  tradeCode?: string;
  tradeLabel?: string;
  recurrenceEligible?: boolean;
  unitLabel?: string;
  recurrenceSupport?: boolean;
};

export function CatalogItemSafetyActions({
  id,
  name,
  active,
}: {
  id: string;
  name: string;
  active: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <div className="space-y-2">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <form
          action={async () => {
            if (
              !window.confirm(
                active ? DEACTIVATE_CATALOG_ITEM_CONFIRM : REACTIVATE_CATALOG_ITEM_CONFIRM,
              )
            ) {
              return;
            }
            setPending(true);
            setError(null);
            const result = await setServiceCatalogItemActive(id, !active);
            setPending(false);
            if (result.error) setError(result.error);
          }}
        >
          <Button type="submit" variant="outline" size="sm" disabled={pending}>
            {active ? "Deactivate" : "Reactivate"}
          </Button>
        </form>
        <form
          action={async () => {
            if (!window.confirm(DELETE_CATALOG_ITEM_CONFIRM)) {
              return;
            }
            setPending(true);
            setError(null);
            const result = await deleteServiceCatalogItem(id);
            setPending(false);
            if (result.error) setError(result.error);
          }}
        >
          <Button type="submit" variant="destructive" size="sm" disabled={pending}>
            Delete
          </Button>
        </form>
      </div>
      <p className="text-xs text-muted-foreground">
        Deactivate hides “{name}” from the public request page and new
        estimates. Delete removes it from the catalog. Historical estimate
        lines keep their recorded prices.
      </p>
    </div>
  );
}

export function CatalogItemRow({
  id,
  name,
  pricingMode,
  price,
  displayPrice,
  description,
  category,
  categories,
  active,
  tradeCode,
  tradeLabel,
  recurrenceEligible = false,
  unitLabel = "",
  recurrenceSupport = false,
}: CatalogItemRowProps) {
  const [state, action, pending] = useActionState(
    updateServiceCatalogItem,
    initialState,
  );
  const [mode, setMode] = useState(pricingMode);
  const [scope, setScope] = useState(description);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words font-medium">{name}</p>
          <p className="text-sm text-muted-foreground">
            {displayPrice}
            {tradeLabel ? ` · ${tradeLabel}` : null}
          </p>
        </div>
        <Badge variant={active ? "secondary" : "outline"}>
          {active ? "Active" : "Inactive"}
        </Badge>
      </div>

      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <form action={action} className="space-y-3">
        <input type="hidden" name="id" value={id} />
        <div className="space-y-2">
          <Label htmlFor={`name-${id}`}>Name</Label>
          <Input id={`name-${id}`} name="name" defaultValue={name} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`category-${id}`}>Category</Label>
          <Input
            id={`category-${id}`}
            name="category"
            list={`catalog-category-options-${id}`}
            defaultValue={category || DEFAULT_SERVICE_CATEGORY}
          />
          <datalist id={`catalog-category-options-${id}`}>
            {categories.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`pricingMode-${id}`}>Pricing mode</Label>
          <select
            id={`pricingMode-${id}`}
            name="pricingMode"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="STARTING_AT">Starting at</option>
            <option value="FIXED">Fixed</option>
            <option value="VARIABLE">Variable / unit</option>
            <option value="CUSTOM_QUOTE">Custom Quote</option>
          </select>
        </div>
        {mode === "CUSTOM_QUOTE" ? (
          <div className="space-y-2">
            <Label htmlFor={`price-${id}`}>Default starting price (optional)</Label>
            <Input
              id={`price-${id}`}
              name="price"
              inputMode="decimal"
              defaultValue={price}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor={`price-${id}`}>Price</Label>
            <Input
              id={`price-${id}`}
              name="price"
              inputMode="decimal"
              defaultValue={price}
              required
            />
          </div>
        )}
        {mode === "VARIABLE" ? (
          <div className="space-y-2">
            <Label htmlFor={`unitLabel-${id}`}>Unit label</Label>
            <Input
              id={`unitLabel-${id}`}
              name="unitLabel"
              defaultValue={unitLabel}
              placeholder="per hour, per room, per visit"
            />
          </div>
        ) : null}
        {recurrenceSupport ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="hidden" name="recurrenceEligibleSubmitted" value="1" />
            <input
              type="checkbox"
              name="recurrenceEligible"
              value="on"
              defaultChecked={recurrenceEligible}
            />
            Recurring service
          </label>
        ) : null}
        {tradeCode ? (
          <p className="text-sm text-muted-foreground">
            Trade: {tradeLabel || tradeCode}
          </p>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor={`description-${id}`}>Scope / Included Work</Label>
          <textarea
            id={`description-${id}`}
            name="description"
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            rows={4}
            className="min-h-20 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none md:text-sm"
          />
          <WritingAssistBar
            original={scope}
            context="Service catalog scope and included work. Do not invent prices, licenses, or guarantees."
            onSuggestion={setScope}
          />
        </div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </form>

      <CatalogItemSafetyActions id={id} name={name} active={active} />
    </div>
  );
}

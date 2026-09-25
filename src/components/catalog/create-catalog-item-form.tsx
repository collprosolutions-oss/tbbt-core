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
import { OperatingWriteGate, useSaasOperating } from "@/components/saas/saas-operating-context";
import { WritingAssistBar } from "@/components/ai/writing-assist-bar";
import type { ActiveCatalogTradeOption } from "@/components/services/types";

const initialState: CatalogActionState = {};

export function CreateCatalogItemForm({
  categories,
  activeTrades = [],
}: {
  categories: string[];
  activeTrades?: ActiveCatalogTradeOption[];
}) {
  const [state, action, pending] = useActionState(
    createServiceCatalogItem,
    initialState,
  );
  const [mode, setMode] = useState("STARTING_AT");
  const [description, setDescription] = useState("");
  const [tradeCode, setTradeCode] = useState(activeTrades[0]?.code ?? "");
  const operating = useSaasOperating();
  const selectedTrade =
    activeTrades.find((trade) => trade.code === tradeCode) ?? activeTrades[0] ?? null;

  if (!operating.canOperate) {
    return <OperatingWriteGate fallbackLabel="Add service" />;
  }

  return (
    <form action={action} className="space-y-3">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {activeTrades.length > 1 ? (
        <div className="space-y-2">
          <Label htmlFor="tradeCode">Trade</Label>
          <select
            id="tradeCode"
            name="tradeCode"
            value={tradeCode}
            onChange={(event) => setTradeCode(event.target.value)}
            required
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            {activeTrades.map((trade) => (
              <option key={trade.code} value={trade.code}>
                {trade.label}
              </option>
            ))}
          </select>
        </div>
      ) : activeTrades[0] ? (
        <input type="hidden" name="tradeCode" value={activeTrades[0].code} />
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
          <option value="VARIABLE">Variable / unit</option>
          <option value="CUSTOM_QUOTE">Custom Quote</option>
        </select>
      </div>
      {mode === "CUSTOM_QUOTE" ? (
        <div className="space-y-2">
          <Label htmlFor="price">Default starting price (optional)</Label>
          <Input id="price" name="price" inputMode="decimal" />
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="price">Price</Label>
          <Input id="price" name="price" inputMode="decimal" required />
        </div>
      )}
      {mode === "VARIABLE" ? (
        <div className="space-y-2">
          <Label htmlFor="unitLabel">Unit label</Label>
          <Input
            id="unitLabel"
            name="unitLabel"
            placeholder="per hour, per room, per visit"
          />
        </div>
      ) : null}
      {selectedTrade?.recurrenceSupport ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="hidden" name="recurrenceEligibleSubmitted" value="1" />
          <input type="checkbox" name="recurrenceEligible" value="on" />
          Recurring service
        </label>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="description">Scope / Included Work (optional)</Label>
        <textarea
          id="description"
          name="description"
          rows={4}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="min-h-20 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none md:text-sm"
        />
        <WritingAssistBar
          original={description}
          context="Service catalog scope and included work. Do not invent prices, licenses, or guarantees."
          onSuggestion={setDescription}
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Add service"}
      </Button>
    </form>
  );
}

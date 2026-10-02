"use client";

import { useActionState } from "react";
import {
  selectSupplierQuoteForPurchaseListAction,
  type MaterialsActionState,
} from "@/app/actions/materials";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";
import type { SupplierQuoteCompareRow } from "@/lib/materials/types";

const initial: MaterialsActionState = {};

function QuoteStatus({ state }: { state: MaterialsActionState }) {
  if (state.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{state.error}</AlertDescription>
      </Alert>
    );
  }
  if (state.message) {
    return (
      <Alert>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

export function SupplierQuoteCompareTable({
  quotes,
  selectedQuoteId,
  purchaseListItemId,
  jobId,
  estimateId,
  canSelect,
}: {
  quotes: SupplierQuoteCompareRow[];
  selectedQuoteId?: string | null;
  purchaseListItemId?: string | null;
  jobId?: string | null;
  estimateId?: string | null;
  canSelect?: boolean;
}) {
  if (quotes.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No dated supplier quotes yet. Record two or more to compare unit price, quantity,
        delivery, and availability.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-xs">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="py-1 pr-2 font-medium">Supplier</th>
            <th className="py-1 pr-2 font-medium">Quoted</th>
            <th className="py-1 pr-2 font-medium">Unit price</th>
            <th className="py-1 pr-2 font-medium">Qty</th>
            <th className="py-1 pr-2 font-medium">Delivery</th>
            <th className="py-1 pr-2 font-medium">Availability</th>
            <th className="py-1 pr-2 font-medium">Comparable</th>
            <th className="py-1 pr-2 font-medium">Landed for need</th>
            {canSelect && purchaseListItemId ? <th className="py-1 font-medium">Choose</th> : null}
          </tr>
        </thead>
        <tbody>
          {quotes.map((quote) => (
            <tr
              key={quote.quoteId}
              className={
                selectedQuoteId === quote.quoteId
                  ? "border-b bg-muted/40"
                  : "border-b last:border-0"
              }
            >
              <td className="py-1.5 pr-2">
                {quote.supplierName}
                {quote.lowestLanded ? (
                  <span className="ml-1 text-muted-foreground">lowest</span>
                ) : null}
              </td>
              <td className="py-1.5 pr-2">
                {new Date(quote.quotedAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
                <span className="block text-muted-foreground">
                  {quote.freshnessLabel}
                  {quote.stale ? " — confirm before choosing" : ""}
                </span>
              </td>
              <td className="py-1.5 pr-2">
                {formatMoney(quote.unitPrice)} / {quote.unit}
              </td>
              <td className="py-1.5 pr-2">
                {quote.quantity} {quote.unit}
              </td>
              <td className="py-1.5 pr-2">{formatMoney(quote.deliveryCost)}</td>
              <td className="py-1.5 pr-2">{quote.availabilityLabel}</td>
              <td className="py-1.5 pr-2">
                {quote.conversionError ? (
                  <span className="text-destructive">{quote.conversionError}</span>
                ) : (
                  <>
                    {quote.comparableUnitPrice
                      ? `${formatMoney(quote.comparableUnitPrice)} / ${quote.comparableUnit}`
                      : "—"}
                    {quote.conversionLabel ? (
                      <span className="block text-muted-foreground">{quote.conversionLabel}</span>
                    ) : null}
                  </>
                )}
              </td>
              <td className="py-1.5 pr-2">
                {quote.neededLandedTotal ? formatMoney(quote.neededLandedTotal) : formatMoney(quote.quoteLandedTotal)}
                <span className="block text-muted-foreground">
                  quote total {formatMoney(quote.quoteLandedTotal)}
                </span>
              </td>
              {canSelect && purchaseListItemId ? (
                <td className="py-1.5">
                  <SelectQuoteForm
                    quote={quote}
                    purchaseListItemId={purchaseListItemId}
                    selectedQuoteId={selectedQuoteId ?? null}
                    jobId={jobId}
                    estimateId={estimateId}
                  />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SelectQuoteForm({
  quote,
  purchaseListItemId,
  selectedQuoteId,
  jobId,
  estimateId,
}: {
  quote: SupplierQuoteCompareRow;
  purchaseListItemId: string;
  selectedQuoteId: string | null;
  jobId?: string | null;
  estimateId?: string | null;
}) {
  const [state, action, pending] = useActionState(
    selectSupplierQuoteForPurchaseListAction,
    initial,
  );
  const alreadySelected = selectedQuoteId === quote.quoteId;
  return (
    <form action={action} className="space-y-1">
      <QuoteStatus state={state} />
      <input type="hidden" name="quoteId" value={quote.quoteId} />
      <input type="hidden" name="purchaseListItemId" value={purchaseListItemId} />
      <input type="hidden" name="expectedSelectedQuoteId" value={selectedQuoteId ?? ""} />
      {jobId ? <input type="hidden" name="jobId" value={jobId} /> : null}
      {estimateId ? <input type="hidden" name="estimateId" value={estimateId} /> : null}
      {quote.stale ? (
        <label className="flex items-center gap-1 text-muted-foreground">
          <input type="checkbox" name="acceptStale" value="1" />
          Use stale quote
        </label>
      ) : null}
      <Button type="submit" size="sm" variant="outline" disabled={pending || alreadySelected}>
        {alreadySelected ? "Selected" : pending ? "Applying…" : "Use quote"}
      </Button>
    </form>
  );
}

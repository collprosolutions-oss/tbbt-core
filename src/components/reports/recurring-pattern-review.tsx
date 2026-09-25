"use client";

import { useActionState } from "react";
import { reviewRecurringPatternAction } from "@/app/actions/financial-intelligence";
import { Button } from "@/components/ui/button";
import type { RecurringExpenseSuggestion } from "@/lib/financial-intelligence";

export function RecurringPatternReview({ row }: { row: RecurringExpenseSuggestion }) {
  const [state, action, pending] = useActionState(reviewRecurringPatternAction, {});

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="patternKey" value={row.patternKey} />
      <input type="hidden" name="description" value={row.description} />
      <input type="hidden" name="vendor" value={row.vendor ?? ""} />
      <input type="hidden" name="category" value={row.category} />
      <input type="hidden" name="suggestedAmount" value={String(row.suggestedAmount)} />
      <input type="hidden" name="occurrenceCount" value={String(row.occurrenceCount)} />
      <input type="hidden" name="firstOccurredOn" value={row.firstOccurredOn.toISOString()} />
      <input type="hidden" name="lastOccurredOn" value={row.lastOccurredOn.toISOString()} />
      {row.ownerStatus === "SUGGESTED" ? (
        <>
          <Button type="submit" name="ownerStatus" value="CONFIRMED" size="sm" disabled={pending}>
            Confirm pattern
          </Button>
          <Button type="submit" name="ownerStatus" value="DISMISSED" size="sm" variant="outline" disabled={pending}>
            Dismiss
          </Button>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{row.ownerStatus}</p>
      )}
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

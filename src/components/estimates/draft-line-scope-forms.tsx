"use client";

import { useActionState } from "react";
import {
  saveEstimateLineForReuse,
  updateEstimateLineIncludedWork,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const initialState: EstimateActionState = {};

export function EditLineIncludedWorkForm({
  estimateId,
  lineItemId,
  includedWork,
}: {
  estimateId: string;
  lineItemId: string;
  includedWork?: string | null;
}) {
  const [state, action, pending] = useActionState(
    updateEstimateLineIncludedWork,
    initialState,
  );

  return (
    <form action={action} className="mt-2 space-y-2">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <p className="text-xs text-muted-foreground">{state.message}</p>
      ) : null}
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="lineItemId" value={lineItemId} />
      <div className="space-y-1">
        <Label htmlFor={`included-work-${lineItemId}`}>
          Scope / Included Work
        </Label>
        <textarea
          id={`included-work-${lineItemId}`}
          name="includedWork"
          defaultValue={includedWork ?? ""}
          rows={6}
          placeholder="What this price includes, one item per line"
          className="min-h-24 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none md:text-sm"
        />
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Save scope"}
      </Button>
    </form>
  );
}

export function SaveLineForReuseForm({
  estimateId,
  lineItemId,
  hasPrice,
}: {
  estimateId: string;
  lineItemId: string;
  hasPrice: boolean;
}) {
  const [state, action, pending] = useActionState(
    saveEstimateLineForReuse,
    initialState,
  );

  return (
    <form action={action} className="mt-2 space-y-2">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <p className="text-xs text-muted-foreground">{state.message}</p>
      ) : null}
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="lineItemId" value={lineItemId} />
      {hasPrice ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="savePrice"
            value="1"
            defaultChecked
            className="mt-1"
          />
          <span>Also save the current price as a default starting point</span>
        </label>
      ) : (
        <input type="hidden" name="savePrice" value="0" />
      )}
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? "Saving…" : "Save for Future Use"}
      </Button>
    </form>
  );
}

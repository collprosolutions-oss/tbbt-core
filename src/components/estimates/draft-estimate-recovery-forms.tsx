"use client";

import { useActionState } from "react";
import {
  resetEstimateTakeoffAndGeneratedMaterials,
  restoreEstimateOriginalRequestPricing,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Button } from "@/components/ui/button";

const initialState: EstimateActionState = {};

export const RESET_TAKEOFF_CONFIRM =
  "Reset takeoff experiments?\n\nThis will KEEP:\n• The original customer-request labor/work line (never deleted)\n• The customer request, property, photos, and intake\n• Saved Scope / Included Work\n• Unrelated custom estimate lines you added\n\nThis will REMOVE:\n• MATERIAL lines generated from this takeoff (bags, mesh, form boards, pickup, etc.)\n• Owner quantity, customer price, markup helper, and converted-item edits\n\nCalculated takeoff defaults from the current dimensions will be restored. Material Takeoff stays on the original labor line.\n\nDoes not change sent or approved estimates.";

export const RESTORE_ORIGINAL_REQUEST_PRICING_CONFIRM =
  "Restore the original customer-request labor line?\n\nThis will KEEP:\n• The original labor/work line itself (never deleted)\n• The customer request, property, photos, and intake measurements\n• Saved Scope / Included Work\n• Unrelated custom estimate lines you added\n\nThis will REMOVE:\n• MATERIAL lines generated from this takeoff (bags, mesh, form boards, pickup, etc.)\n• Takeoff quantity, price, markup, and conversion experiments\n• Applied labor/takeoff prices on the original request line\n• The material deposit override\n\nThe original labor/work line returns to the unpriced draft state and keeps Material Takeoff so you can recalculate from scratch.\n\nDoes not change sent or approved estimates.";

export const RESTORE_MISSING_ORIGINAL_REQUEST_LINE_CONFIRM =
  "Restore the original request labor/work line from the linked customer request?\n\nThis draft no longer has that original labor line. The Concrete/custom calculators themselves were never deleted — they are permanent TBBT estimating tools.\n\nThis will KEEP:\n• The customer request, property, photos, and intake\n• Unrelated custom estimate lines that are still on this draft\n• Labor and material calculator capability for this trade\n\nThis will:\n• Recreate the original unpriced request labor/work line (no duplicate if it already exists)\n• Remove leftover takeoff-generated MATERIAL lines\n• Make Labor Calculator and Material Calculator available on that labor line so you can recalculate from scratch\n\nDoes not change sent or approved estimates.";

export function ResetTakeoffAndGeneratedMaterialsForm({
  estimateId,
  lineItemId,
}: {
  estimateId: string;
  lineItemId: string;
}) {
  const [state, formAction, pending] = useActionState(
    resetEstimateTakeoffAndGeneratedMaterials,
    initialState,
  );

  return (
    <form
      action={(formData) => {
        if (!window.confirm(RESET_TAKEOFF_CONFIRM)) {
          return;
        }
        formAction(formData);
      }}
      className="space-y-2"
    >
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="lineItemId" value={lineItemId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Resetting…" : "Reset Takeoff & Generated Materials"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Removes takeoff-generated materials and owner takeoff edits only. The
        original customer-request labor/work line is never deleted.
      </p>
      {state.error ? (
        <p className="text-sm text-destructive">{state.error}</p>
      ) : null}
      {state.message ? (
        <p className="text-xs text-muted-foreground">{state.message}</p>
      ) : null}
    </form>
  );
}

export function RestoreOriginalRequestPricingForm({
  estimateId,
  lineItemId,
  missingOriginalLine = false,
}: {
  estimateId: string;
  lineItemId?: string;
  missingOriginalLine?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    restoreEstimateOriginalRequestPricing,
    initialState,
  );
  const confirmText = missingOriginalLine
    ? RESTORE_MISSING_ORIGINAL_REQUEST_LINE_CONFIRM
    : RESTORE_ORIGINAL_REQUEST_PRICING_CONFIRM;

  return (
    <form
      action={(formData) => {
        if (!window.confirm(confirmText)) {
          return;
        }
        formAction(formData);
      }}
      className={missingOriginalLine ? "space-y-2" : "mt-2 space-y-2"}
    >
      <input type="hidden" name="estimateId" value={estimateId} />
      {lineItemId ? (
        <input type="hidden" name="lineItemId" value={lineItemId} />
      ) : null}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending
          ? "Restoring…"
          : missingOriginalLine
            ? "Restore original request labor line"
            : "Restore Original Request Pricing"}
      </Button>
      <p className="text-xs text-muted-foreground">
        {missingOriginalLine
          ? "Recreates the original unpriced request labor/work line from the linked customer request. Labor and material calculators stay available. Does not create a duplicate."
          : "Returns this labor/request line to the unpriced draft state and removes takeoff-generated materials only. The original labor/work line stays."}
      </p>
      {state.error ? (
        <p className="text-sm text-destructive">{state.error}</p>
      ) : null}
      {state.message ? (
        <p className="text-xs text-muted-foreground">{state.message}</p>
      ) : null}
    </form>
  );
}

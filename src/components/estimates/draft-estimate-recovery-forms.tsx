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
  "Reset takeoff and generated materials?\n\nThis will:\n• Remove MATERIAL lines generated from this takeoff\n• Clear owner quantity, customer price, markup helper, and converted-item edits\n• Restore calculated takeoff defaults from the current dimensions and options\n\nThis will keep:\n• The original customer request, customer/property, and request photos\n• The original labor/request line and saved Scope / Included Work\n• Unrelated custom estimate lines\n\nThis only works on DRAFT estimates. Sent and approved estimates are not changed.";

export const RESTORE_ORIGINAL_REQUEST_PRICING_CONFIRM =
  "Restore original request pricing?\n\nThis will:\n• Return the original labor/request line to the pre-priced draft state ($0 custom quote, or the original catalog price where that is safer)\n• Remove MATERIAL lines generated from this takeoff\n• Clear the material deposit override on this draft\n\nThis will keep:\n• Request details, photos, intake, and saved Scope / Included Work\n• Unrelated estimate lines\n\nThis only works on DRAFT estimates. Sent and approved estimates are not changed.";

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
        Undo takeoff quantity, price, and conversion experiments. Does not
        change the original request, photos, or saved scope.
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
}: {
  estimateId: string;
  lineItemId: string;
}) {
  const [state, formAction, pending] = useActionState(
    restoreEstimateOriginalRequestPricing,
    initialState,
  );

  return (
    <form
      action={(formData) => {
        if (!window.confirm(RESTORE_ORIGINAL_REQUEST_PRICING_CONFIRM)) {
          return;
        }
        formAction(formData);
      }}
      className="mt-2 space-y-2"
    >
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="lineItemId" value={lineItemId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Restoring…" : "Restore Original Request Pricing"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Return this labor/request line to the pre-priced draft state and
        remove takeoff-generated materials. Unrelated lines stay.
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

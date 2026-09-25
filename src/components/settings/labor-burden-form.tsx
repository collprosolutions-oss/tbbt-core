"use client";

import { useActionState } from "react";
import { saveLaborBurdenAction } from "@/app/actions/financial-intelligence";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatRatePercent } from "@/lib/financial-intelligence";

export function LaborBurdenForm({
  burdenRate,
  targetGrossMarginRate,
  notes,
  canEditBurden,
  canEditTarget,
}: {
  burdenRate: number | null;
  targetGrossMarginRate: number | null;
  notes: string | null;
  canEditBurden: boolean;
  canEditTarget: boolean;
}) {
  const [state, action, pending] = useActionState(saveLaborBurdenAction, {});
  const burdenDefault = burdenRate == null ? "" : String(burdenRate * 100);
  const targetDefault = targetGrossMarginRate == null ? "" : String(targetGrossMarginRate * 100);
  const canSubmit = canEditBurden || canEditTarget;

  return (
    <form action={action} className="space-y-3">
      <p className="text-sm text-muted-foreground">
        These fields are percents. Enter 1 for 1%, 0.5 for 0.5%, 12.5 for 12.5%, or 40 for 40%.
        TBBT stores them as decimal fractions. Employer burden is an owner-configured planning
        assumption, not a recorded cash fact, and never rewrites historical wage snapshots.
        {formatRatePercent(burdenRate) ? ` Current burden assumption: ${formatRatePercent(burdenRate)}.` : ""}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="burdenRate">Employer burden %</Label>
          <Input
            id="burdenRate"
            name="burdenRate"
            defaultValue={burdenDefault}
            placeholder="Blank = none"
            disabled={!canEditBurden || pending}
            inputMode="decimal"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="targetGrossMarginRate">Owner target margin %</Label>
          <Input
            id="targetGrossMarginRate"
            name="targetGrossMarginRate"
            defaultValue={targetDefault}
            placeholder="Blank = no target"
            disabled={!canEditTarget || pending}
            inputMode="decimal"
          />
          {!canEditTarget ? (
            <p className="text-xs text-muted-foreground">Only the owner can change the target margin.</p>
          ) : null}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="burdenNotes">Notes</Label>
        <Input
          id="burdenNotes"
          name="notes"
          defaultValue={notes ?? ""}
          placeholder="What this burden assumption covers"
          disabled={!canEditBurden || pending}
        />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
      {canSubmit ? (
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save burden settings"}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">Owner or admin settings access is required to change burden. Target margin is owner-only.</p>
      )}
    </form>
  );
}

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
  canEdit,
}: {
  burdenRate: number | null;
  targetGrossMarginRate: number | null;
  notes: string | null;
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(saveLaborBurdenAction, {});
  const burdenDefault = burdenRate == null ? "" : String(burdenRate * 100);
  const targetDefault = targetGrossMarginRate == null ? "" : String(targetGrossMarginRate * 100);

  return (
    <form action={action} className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Optional employer burden (payroll taxes, insurance, overhead contribution). Leave blank for wage-only
        labor cost. TBBT does not invent a default percentage.
        {formatRatePercent(burdenRate) ? ` Current burden: ${formatRatePercent(burdenRate)}.` : ""}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="burdenRate">Employer burden %</Label>
          <Input
            id="burdenRate"
            name="burdenRate"
            defaultValue={burdenDefault}
            placeholder="Blank = none"
            disabled={!canEdit || pending}
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
            disabled={!canEdit || pending}
            inputMode="decimal"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="burdenNotes">Notes</Label>
        <Input
          id="burdenNotes"
          name="notes"
          defaultValue={notes ?? ""}
          placeholder="What this burden covers"
          disabled={!canEdit || pending}
        />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
      {canEdit ? (
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save burden settings"}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">Owner or admin settings access is required to change this.</p>
      )}
    </form>
  );
}

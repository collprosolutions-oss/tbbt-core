"use client";

import { useActionState, useMemo, useState } from "react";
import { applyEstimateCalculator, type EstimateActionState } from "@/app/actions/estimate";
import { CalculatorBreakdown } from "@/components/estimates/calculator-breakdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  computeDecorativeWallPaneling,
  emptyDecorativeWallPanelingInputs,
  grossWallAreaSqFt,
  normalizeDecorativeWallPanelingInputs,
  normalizeDecorativeWallPanelingRates,
  suggestedPanelEquivalents,
  type DecorativeWallPanelingInputs,
  type DecorativeWallPanelingRates,
} from "@/lib/estimate-calculators";
import { formatMoney } from "@/lib/format";

const initialState: EstimateActionState = {};

export function VariableScopeCalculatorForm({
  estimateId,
  lineItemId,
  inputs,
  rates,
}: {
  estimateId: string;
  lineItemId: string;
  inputs?: Record<string, unknown> | null;
  rates?: Record<string, unknown> | null;
}) {
  const [state, action, pending] = useActionState(applyEstimateCalculator, initialState);
  const startingRates = normalizeDecorativeWallPanelingRates(
    rates ?? DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  );
  const startingInputs = normalizeDecorativeWallPanelingInputs(
    inputs ?? emptyDecorativeWallPanelingInputs(startingRates),
    startingRates,
  );
  const [draft, setDraft] = useState<DecorativeWallPanelingInputs>(startingInputs);
  const [draftRates, setDraftRates] = useState<DecorativeWallPanelingRates>(startingRates);

  const area = grossWallAreaSqFt(draft.wallWidthFt, draft.wallHeightFt);
  const suggestedPanels = suggestedPanelEquivalents(draft.wallWidthFt, draft.wallHeightFt);
  const preview = useMemo(
    () => computeDecorativeWallPaneling(draft, draftRates),
    [draft, draftRates],
  );

  function setInput<K extends keyof DecorativeWallPanelingInputs>(
    key: K,
    value: DecorativeWallPanelingInputs[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function setRate<K extends keyof DecorativeWallPanelingRates>(
    key: K,
    value: number,
  ) {
    setDraftRates((current) => ({ ...current, [key]: value }));
  }

  return (
    <form action={action} className="mt-3 space-y-3 rounded-lg border border-border p-3">
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="lineItemId" value={lineItemId} />
      <div>
        <p className="text-sm font-medium">Variable-scope labor calculator</p>
        <p className="text-xs text-muted-foreground">
          Owner/internal only. Uses gross wall area. Openings are priced
          separately instead of subtracted from labor area.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <NumberField
          id={`width-${lineItemId}`}
          name="wallWidthFt"
          label="Wall width (ft)"
          value={draft.wallWidthFt}
          onChange={(value) => setInput("wallWidthFt", value)}
        />
        <NumberField
          id={`height-${lineItemId}`}
          name="wallHeightFt"
          label="Wall height (ft)"
          value={draft.wallHeightFt}
          onChange={(value) => setInput("wallHeightFt", value)}
        />
        <div className="space-y-1">
          <Label>Gross wall area</Label>
          <p className="flex h-8 items-center text-sm">{area} sq ft</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`removal-${lineItemId}`}>Existing material removal</Label>
          <select
            id={`removal-${lineItemId}`}
            name="removalType"
            value={draft.removalType}
            onChange={(event) =>
              setInput("removalType", event.target.value as DecorativeWallPanelingInputs["removalType"])
            }
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="none">None</option>
            <option value="metal_siding">Metal siding</option>
            <option value="paneling">Paneling</option>
            <option value="other">Other</option>
          </select>
        </div>
        <NumberField
          id={`panels-${lineItemId}`}
          name="panelQuantity"
          label={`Panel/sheet quantity (auto ${suggestedPanels} of 4×8)`}
          value={draft.panelQuantity ?? ""}
          onChange={(value) => setInput("panelQuantity", value > 0 ? value : null)}
          allowEmpty
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <NumberField
          id={`patio-${lineItemId}`}
          name="slidingPatioDoors"
          label="Sliding/patio door openings"
          value={draft.slidingPatioDoors}
          onChange={(value) => setInput("slidingPatioDoors", value)}
        />
        <NumberField
          id={`doors-${lineItemId}`}
          name="standardDoors"
          label="Standard door openings"
          value={draft.standardDoors}
          onChange={(value) => setInput("standardDoors", value)}
        />
        <NumberField
          id={`windows-${lineItemId}`}
          name="windows"
          label="Window openings"
          value={draft.windows}
          onChange={(value) => setInput("windows", value)}
        />
        <NumberField
          id={`receptacles-${lineItemId}`}
          name="receptacles"
          label="Receptacles / outlets"
          value={draft.receptacles}
          onChange={(value) => setInput("receptacles", value)}
        />
        <NumberField
          id={`switches-${lineItemId}`}
          name="switches"
          label="Switches"
          value={draft.switches}
          onChange={(value) => setInput("switches", value)}
        />
        <NumberField
          id={`fixtures-${lineItemId}`}
          name="lightFixtures"
          label="Light fixtures"
          value={draft.lightFixtures}
          onChange={(value) => setInput("lightFixtures", value)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <NumberField
          id={`trim-${lineItemId}`}
          name="trimAllowance"
          label="Finish trim / transitions allowance"
          value={draft.trimAllowance}
          onChange={(value) => setInput("trimAllowance", value)}
          step="0.01"
        />
        <NumberField
          id={`cleanup-${lineItemId}`}
          name="cleanupAllowance"
          label="Cleanup / debris handling"
          value={draft.cleanupAllowance}
          onChange={(value) => setInput("cleanupAllowance", value)}
          step="0.01"
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor={`notes-${lineItemId}`}>Optional complexity / add-on notes</Label>
        <textarea
          id={`notes-${lineItemId}`}
          name="notes"
          value={draft.notes}
          onChange={(event) => setInput("notes", event.target.value)}
          rows={3}
          placeholder="Cabinets, furniture, scaffolding, and unusual demolition stay as future add-ons."
          className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm"
        />
      </div>

      <details className="rounded-lg border border-border/60 p-2">
        <summary className="cursor-pointer text-sm font-medium">
          Starting rates (editable for this job)
        </summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <NumberField id={`panelRate-${lineItemId}`} name="panelRate" label="Per 4×8 panel-equivalent" value={draftRates.panelRate} onChange={(value) => setRate("panelRate", value)} step="0.01" />
          <NumberField id={`removalRate-${lineItemId}`} name="removalRatePerSqFt" label="Removal per gross sq ft" value={draftRates.removalRatePerSqFt} onChange={(value) => setRate("removalRatePerSqFt", value)} step="0.01" />
          <NumberField id={`patioRate-${lineItemId}`} name="slidingPatioDoorRate" label="Sliding/patio door each" value={draftRates.slidingPatioDoorRate} onChange={(value) => setRate("slidingPatioDoorRate", value)} step="0.01" />
          <NumberField id={`doorRate-${lineItemId}`} name="standardDoorRate" label="Standard door each" value={draftRates.standardDoorRate} onChange={(value) => setRate("standardDoorRate", value)} step="0.01" />
          <NumberField id={`windowRate-${lineItemId}`} name="windowRate" label="Window each" value={draftRates.windowRate} onChange={(value) => setRate("windowRate", value)} step="0.01" />
          <NumberField id={`receptacleRate-${lineItemId}`} name="receptacleRate" label="Receptacle each" value={draftRates.receptacleRate} onChange={(value) => setRate("receptacleRate", value)} step="0.01" />
          <NumberField id={`switchRate-${lineItemId}`} name="switchRate" label="Switch each" value={draftRates.switchRate} onChange={(value) => setRate("switchRate", value)} step="0.01" />
          <NumberField id={`fixtureRate-${lineItemId}`} name="lightFixtureRate" label="Light fixture each" value={draftRates.lightFixtureRate} onChange={(value) => setRate("lightFixtureRate", value)} step="0.01" />
          <input type="hidden" name="defaultTrimAllowance" value={String(draftRates.defaultTrimAllowance)} />
          <input type="hidden" name="defaultCleanupAllowance" value={String(draftRates.defaultCleanupAllowance)} />
        </div>
      </details>

      <CalculatorBreakdown result={preview} />
      <p className="text-sm">
        Recommended labor price:{" "}
        <span className="font-medium">{formatMoney(preview.recommendedAmount)}</span>
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? "Applying…" : "Apply recommended labor price"}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

function NumberField({
  id,
  name,
  label,
  value,
  onChange,
  step = "1",
  allowEmpty = false,
}: {
  id: string;
  name: string;
  label: string;
  value: number | "";
  onChange: (value: number) => void;
  step?: string;
  allowEmpty?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        inputMode="decimal"
        step={step}
        value={value === 0 && !allowEmpty ? "0" : value === "" ? "" : String(value)}
        onChange={(event) => {
          const raw = event.target.value;
          if (allowEmpty && raw.trim() === "") {
            onChange(0);
            return;
          }
          onChange(Number(raw));
        }}
      />
    </div>
  );
}

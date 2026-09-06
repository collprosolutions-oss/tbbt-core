"use client";

import { useActionState, useMemo, useRef, useState } from "react";
import {
  applyEstimateCalculator,
  persistEstimateCalculatorRates,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { CalculatorBreakdown } from "@/components/estimates/calculator-breakdown";
import { QuantityStepper } from "@/components/estimates/quantity-stepper";
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
import type { CalculatorCustomerPolicy } from "@/lib/estimate-calculators/types";
import {
  BELONGINGS_CLEANUP_LEVELS,
  CONTENTS_PROTECTION_LEVELS,
  WORK_AREA_HANDLING_LEVELS,
  belongingsCleanupLabel,
  contentsProtectionLabel,
  workAreaHandlingLabel,
} from "@/lib/estimate-calculators/work-area-services";
import {
  WORK_AREA_PERSONAL_PROPERTY_POLICY_ID,
  WORK_AREA_PERSONAL_PROPERTY_TITLE,
  defaultWorkAreaPersonalPropertyPolicy,
} from "@/lib/estimate-policies";
import { formatMoney } from "@/lib/format";

const initialState: EstimateActionState = {};

export function VariableScopeCalculatorForm({
  estimateId,
  lineItemId,
  inputs,
  rates,
  customerPolicy,
}: {
  estimateId: string;
  lineItemId: string;
  inputs?: Record<string, unknown> | null;
  rates?: Record<string, unknown> | null;
  customerPolicy?: CalculatorCustomerPolicy | null;
}) {
  const [state, action, pending] = useActionState(applyEstimateCalculator, initialState);
  const startingRates = normalizeDecorativeWallPanelingRates(
    rates ?? DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  );
  const startingInputs = normalizeDecorativeWallPanelingInputs(
    inputs ?? emptyDecorativeWallPanelingInputs(startingRates),
    startingRates,
  );
  const startingPolicy = customerPolicy ?? defaultWorkAreaPersonalPropertyPolicy();
  const [draft, setDraft] = useState<DecorativeWallPanelingInputs>(startingInputs);
  const [draftRates, setDraftRates] = useState<DecorativeWallPanelingRates>(startingRates);
  const [policyBody, setPolicyBody] = useState(startingPolicy.body);
  const lastPersistedRates = useRef(startingRates);
  const lastPersistedPolicy = useRef(startingPolicy.body);

  function persistRates(
    nextRates: DecorativeWallPanelingRates,
    nextPolicyBody = policyBody,
  ) {
    const ratesChanged =
      JSON.stringify(nextRates) !== JSON.stringify(lastPersistedRates.current);
    const policyChanged = nextPolicyBody !== lastPersistedPolicy.current;
    if (!ratesChanged && !policyChanged) return;
    lastPersistedRates.current = nextRates;
    lastPersistedPolicy.current = nextPolicyBody;
    const formData = new FormData();
    formData.set("estimateId", estimateId);
    formData.set("lineItemId", lineItemId);
    for (const [key, value] of Object.entries(nextRates)) {
      formData.set(key, String(value));
    }
    formData.set("customerPolicyId", WORK_AREA_PERSONAL_PROPERTY_POLICY_ID);
    formData.set("customerPolicyTitle", WORK_AREA_PERSONAL_PROPERTY_TITLE);
    formData.set("customerPolicyBody", nextPolicyBody);
    void persistEstimateCalculatorRates(formData);
  }

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

  return (
    <form action={action} className="mt-3 space-y-4 rounded-lg border border-border p-3">
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="lineItemId" value={lineItemId} />
      <input type="hidden" name="customerPolicyId" value={WORK_AREA_PERSONAL_PROPERTY_POLICY_ID} />
      <input type="hidden" name="customerPolicyTitle" value={WORK_AREA_PERSONAL_PROPERTY_TITLE} />
      <div>
        <p className="text-sm font-medium">Variable-scope labor calculator</p>
        <p className="text-xs text-muted-foreground">
          Owner/internal only. Job quantities stay on this estimate. Edited
          rates save automatically as the business default for future estimates.
        </p>
      </div>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Measurements / Area
        </h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField
            id={`width-${lineItemId}`}
            name="wallWidthFt"
            label="Wall width (ft)"
            value={draft.wallWidthFt}
            onChange={(value) => setInput("wallWidthFt", value)}
            step="0.01"
          />
          <NumberField
            id={`height-${lineItemId}`}
            name="wallHeightFt"
            label="Wall height (ft)"
            value={draft.wallHeightFt}
            onChange={(value) => setInput("wallHeightFt", value)}
            step="0.01"
          />
          <div className="space-y-1">
            <Label>Gross wall area</Label>
            <p className="flex h-8 items-center text-sm">
              {area > 0 ? `${area} sq ft` : "—"}
            </p>
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
                setInput(
                  "removalType",
                  event.target.value as DecorativeWallPanelingInputs["removalType"],
                )
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
            label={`Panel/sheet quantity (auto ${suggestedPanels || "—"} of 4×8)`}
            value={draft.panelQuantity ?? ""}
            onChange={(value) => setInput("panelQuantity", value > 0 ? value : null)}
            allowEmpty
          />
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Counted Items
        </h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <QuantityStepper
            id={`patio-${lineItemId}`}
            name="slidingPatioDoors"
            label="Sliding / patio door openings"
            value={draft.slidingPatioDoors}
            onChange={(value) => setInput("slidingPatioDoors", value)}
          />
          <QuantityStepper
            id={`doors-${lineItemId}`}
            name="standardDoors"
            label="Standard door openings"
            value={draft.standardDoors}
            onChange={(value) => setInput("standardDoors", value)}
          />
          <QuantityStepper
            id={`windows-${lineItemId}`}
            name="windows"
            label="Window openings"
            value={draft.windows}
            onChange={(value) => setInput("windows", value)}
          />
          <QuantityStepper
            id={`receptacles-${lineItemId}`}
            name="receptacles"
            label="Receptacles / outlets"
            value={draft.receptacles}
            onChange={(value) => setInput("receptacles", value)}
          />
          <QuantityStepper
            id={`switches-${lineItemId}`}
            name="switches"
            label="Switches"
            value={draft.switches}
            onChange={(value) => setInput("switches", value)}
          />
          <QuantityStepper
            id={`fixtures-${lineItemId}`}
            name="lightFixtures"
            label="Light fixtures"
            value={draft.lightFixtures}
            onChange={(value) => setInput("lightFixtures", value)}
          />
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Allowances / Adjustments
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField
            id={`trim-${lineItemId}`}
            name="trimAllowance"
            label="Finish trim / transitions"
            value={draft.trimAllowance}
            onChange={(value) => setInput("trimAllowance", value)}
            onBlur={() => {
              const nextRates = {
                ...draftRates,
                defaultTrimAllowance: draft.trimAllowance,
              };
              setDraftRates(nextRates);
              persistRates(nextRates);
            }}
            step="0.01"
          />
          <NumberField
            id={`cleanup-${lineItemId}`}
            name="cleanupAllowance"
            label="Construction cleanup / debris handling"
            value={draft.cleanupAllowance}
            onChange={(value) => setInput("cleanupAllowance", value)}
            onBlur={() => {
              const nextRates = {
                ...draftRates,
                defaultCleanupAllowance: draft.cleanupAllowance,
              };
              setDraftRates(nextRates);
              persistRates(nextRates);
            }}
            step="0.01"
          />
        </div>
        <WorkAreaSelect
          id={`handling-${lineItemId}`}
          name="contentsHandlingLevel"
          label="Work-area / contents handling"
          value={draft.contentsHandlingLevel}
          levels={WORK_AREA_HANDLING_LEVELS}
          levelLabel={workAreaHandlingLabel}
          onChange={(value) =>
            setInput("contentsHandlingLevel", value as DecorativeWallPanelingInputs["contentsHandlingLevel"])
          }
        />
        {draft.contentsHandlingLevel === "custom" ? (
          <NumberField
            id={`handling-custom-${lineItemId}`}
            name="contentsHandlingCustomAmount"
            label="Custom contents-handling amount"
            value={draft.contentsHandlingCustomAmount}
            onChange={(value) => setInput("contentsHandlingCustomAmount", value)}
            step="0.01"
          />
        ) : (
          <input type="hidden" name="contentsHandlingCustomAmount" value={String(draft.contentsHandlingCustomAmount)} />
        )}
        <WorkAreaSelect
          id={`protection-${lineItemId}`}
          name="contentsProtectionLevel"
          label="Contents protection"
          value={draft.contentsProtectionLevel}
          levels={CONTENTS_PROTECTION_LEVELS}
          levelLabel={contentsProtectionLabel}
          onChange={(value) =>
            setInput(
              "contentsProtectionLevel",
              value as DecorativeWallPanelingInputs["contentsProtectionLevel"],
            )
          }
        />
        {draft.contentsProtectionLevel === "custom" ? (
          <NumberField
            id={`protection-custom-${lineItemId}`}
            name="contentsProtectionCustomAmount"
            label="Custom contents-protection amount"
            value={draft.contentsProtectionCustomAmount}
            onChange={(value) => setInput("contentsProtectionCustomAmount", value)}
            step="0.01"
          />
        ) : (
          <input type="hidden" name="contentsProtectionCustomAmount" value={String(draft.contentsProtectionCustomAmount)} />
        )}
        <WorkAreaSelect
          id={`belongings-${lineItemId}`}
          name="belongingsCleanupLevel"
          label="Additional customer-belongings cleaning"
          value={draft.belongingsCleanupLevel}
          levels={BELONGINGS_CLEANUP_LEVELS}
          levelLabel={belongingsCleanupLabel}
          onChange={(value) =>
            setInput(
              "belongingsCleanupLevel",
              value as DecorativeWallPanelingInputs["belongingsCleanupLevel"],
            )
          }
        />
        {draft.belongingsCleanupLevel === "custom" ? (
          <NumberField
            id={`belongings-custom-${lineItemId}`}
            name="belongingsCleanupCustomAmount"
            label="Custom belongings-cleanup amount"
            value={draft.belongingsCleanupCustomAmount}
            onChange={(value) => setInput("belongingsCleanupCustomAmount", value)}
            step="0.01"
          />
        ) : (
          <input type="hidden" name="belongingsCleanupCustomAmount" value={String(draft.belongingsCleanupCustomAmount)} />
        )}
        <p className="text-xs text-muted-foreground">
          Keep these separate: moving belongings, protecting belongings left
          in the room, and extra cleaning of those belongings. A clear work
          area with no contractor protection or belongings cleanup adds $0.
        </p>
      </section>

      <div className="space-y-1">
        <Label htmlFor={`notes-${lineItemId}`}>Optional complexity / add-on notes</Label>
        <textarea
          id={`notes-${lineItemId}`}
          name="notes"
          value={draft.notes}
          onChange={(event) => setInput("notes", event.target.value)}
          rows={2}
          placeholder="Cabinets, built-ins, and structural demolition stay as future add-ons."
          className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm"
        />
      </div>

      <details className="rounded-lg border border-border/60 p-2">
        <summary className="cursor-pointer text-sm font-medium">
          Business rates (saved automatically when you edit a rate)
        </summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <RateField id={`panelRate-${lineItemId}`} name="panelRate" label="Per 4×8 panel-equivalent" rateKey="panelRate" value={draftRates.panelRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`removalRate-${lineItemId}`} name="removalRatePerSqFt" label="Removal per gross sq ft" rateKey="removalRatePerSqFt" value={draftRates.removalRatePerSqFt} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`patioRate-${lineItemId}`} name="slidingPatioDoorRate" label="Sliding/patio door each" rateKey="slidingPatioDoorRate" value={draftRates.slidingPatioDoorRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`doorRate-${lineItemId}`} name="standardDoorRate" label="Standard door each" rateKey="standardDoorRate" value={draftRates.standardDoorRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`windowRate-${lineItemId}`} name="windowRate" label="Window each" rateKey="windowRate" value={draftRates.windowRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`receptacleRate-${lineItemId}`} name="receptacleRate" label="Receptacle each" rateKey="receptacleRate" value={draftRates.receptacleRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`switchRate-${lineItemId}`} name="switchRate" label="Switch each" rateKey="switchRate" value={draftRates.switchRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`fixtureRate-${lineItemId}`} name="lightFixtureRate" label="Light fixture each" rateKey="lightFixtureRate" value={draftRates.lightFixtureRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`handlingLight-${lineItemId}`} name="contentsHandlingLightRate" label="Contents handling — light" rateKey="contentsHandlingLightRate" value={draftRates.contentsHandlingLightRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`handlingMod-${lineItemId}`} name="contentsHandlingModerateRate" label="Contents handling — moderate" rateKey="contentsHandlingModerateRate" value={draftRates.contentsHandlingModerateRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`handlingHeavy-${lineItemId}`} name="contentsHandlingHeavyRate" label="Contents handling — heavy" rateKey="contentsHandlingHeavyRate" value={draftRates.contentsHandlingHeavyRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`protectLight-${lineItemId}`} name="contentsProtectionLightRate" label="Contents protection — light" rateKey="contentsProtectionLightRate" value={draftRates.contentsProtectionLightRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`protectMod-${lineItemId}`} name="contentsProtectionModerateRate" label="Contents protection — moderate" rateKey="contentsProtectionModerateRate" value={draftRates.contentsProtectionModerateRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`protectHeavy-${lineItemId}`} name="contentsProtectionHeavyRate" label="Contents protection — heavy" rateKey="contentsProtectionHeavyRate" value={draftRates.contentsProtectionHeavyRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`belongLight-${lineItemId}`} name="belongingsCleanupLightRate" label="Belongings cleanup — light" rateKey="belongingsCleanupLightRate" value={draftRates.belongingsCleanupLightRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`belongMod-${lineItemId}`} name="belongingsCleanupModerateRate" label="Belongings cleanup — moderate" rateKey="belongingsCleanupModerateRate" value={draftRates.belongingsCleanupModerateRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <RateField id={`belongHeavy-${lineItemId}`} name="belongingsCleanupHeavyRate" label="Belongings cleanup — heavy" rateKey="belongingsCleanupHeavyRate" value={draftRates.belongingsCleanupHeavyRate} draftRates={draftRates} setDraftRates={setDraftRates} persistRates={persistRates} />
          <input type="hidden" name="defaultTrimAllowance" value={String(draftRates.defaultTrimAllowance)} />
          <input type="hidden" name="defaultCleanupAllowance" value={String(draftRates.defaultCleanupAllowance)} />
        </div>
      </details>

      <details className="rounded-lg border border-border/60 p-2">
        <summary className="cursor-pointer text-sm font-medium">
          Customer-facing Work Area & Personal Property terms
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">
          Business policy/template, not legal advice. Editing this wording
          saves it as this business&apos;s future default. SENT estimates keep
          the wording that was sent.
        </p>
        <textarea
          name="customerPolicyBody"
          value={policyBody}
          onChange={(event) => setPolicyBody(event.target.value)}
          onBlur={() => persistRates(draftRates, policyBody)}
          rows={8}
          className="mt-2 min-h-32 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm"
        />
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

function WorkAreaSelect({
  id,
  name,
  label,
  value,
  levels,
  levelLabel,
  onChange,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  levels: readonly string[];
  levelLabel: (level: string) => string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
      >
        {levels.map((level) => (
          <option key={level} value={level}>
            {levelLabel(level)}
          </option>
        ))}
      </select>
    </div>
  );
}

function RateField({
  id,
  name,
  label,
  rateKey,
  value,
  draftRates,
  setDraftRates,
  persistRates,
}: {
  id: string;
  name: string;
  label: string;
  rateKey: keyof DecorativeWallPanelingRates;
  value: number;
  draftRates: DecorativeWallPanelingRates;
  setDraftRates: (
    update:
      | DecorativeWallPanelingRates
      | ((current: DecorativeWallPanelingRates) => DecorativeWallPanelingRates),
  ) => void;
  persistRates: (rates: DecorativeWallPanelingRates) => void;
}) {
  return (
    <NumberField
      id={id}
      name={name}
      label={label}
      value={value}
      step="0.01"
      onChange={(next) =>
        setDraftRates((current) => ({ ...current, [rateKey]: next }))
      }
      onBlur={() => {
        const next = { ...draftRates, [rateKey]: value };
        setDraftRates(next);
        persistRates(next);
      }}
    />
  );
}

function NumberField({
  id,
  name,
  label,
  value,
  onChange,
  onBlur,
  step = "1",
  allowEmpty = false,
}: {
  id: string;
  name: string;
  label: string;
  value: number | "";
  onChange: (value: number) => void;
  onBlur?: () => void;
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
        onBlur={onBlur}
      />
    </div>
  );
}

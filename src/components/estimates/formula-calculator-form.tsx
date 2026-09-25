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
  computeFormula,
  persistableFormulaRates,
  type FormulaContract,
} from "@/lib/estimate-calculators/formula-contract";
import { PRODUCTION_UNIT_LABELS } from "@/lib/estimate-calculators/unit-registry";
import { formatMoney } from "@/lib/format";

const initialState: EstimateActionState = {};

export function FormulaCalculatorForm({
  estimateId,
  lineItemId,
  formula,
  inputs,
  rates,
}: {
  estimateId: string;
  lineItemId: string;
  formula: FormulaContract;
  inputs?: Record<string, unknown> | null;
  rates?: Record<string, unknown> | null;
}) {
  const [state, action, pending] = useActionState(applyEstimateCalculator, initialState);
  const startingRates = persistableFormulaRates(formula, rates);
  const startingInputs = {
    ...Object.fromEntries(
      quantityFields(formula).map((field) => [field.key, 0]),
    ),
    ...(inputs ?? {}),
  };
  const [draftInputs, setDraftInputs] = useState<Record<string, unknown>>(startingInputs);
  const [draftRates, setDraftRates] = useState<Record<string, number>>(startingRates);
  const lastPersistedRates = useRef(startingRates);

  const payload = useMemo(
    () => JSON.stringify({ inputs: draftInputs, rates: draftRates }),
    [draftInputs, draftRates],
  );
  const preview = useMemo(
    () => computeFormula(formula, draftInputs, draftRates),
    [formula, draftInputs, draftRates],
  );

  function persistRates(nextRates: Record<string, number>) {
    if (JSON.stringify(nextRates) === JSON.stringify(lastPersistedRates.current)) {
      return;
    }
    lastPersistedRates.current = nextRates;
    const formData = new FormData();
    formData.set("estimateId", estimateId);
    formData.set("lineItemId", lineItemId);
    formData.set(
      "variableScopePayload",
      JSON.stringify({ inputs: draftInputs, rates: nextRates }),
    );
    void persistEstimateCalculatorRates(formData);
  }

  return (
    <form action={action} className="mt-3 space-y-3 rounded-lg border border-border/60 p-3">
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="lineItemId" value={lineItemId} />
      <input type="hidden" name="variableScopePayload" value={payload} />
      <p className="text-xs font-medium text-muted-foreground">
        Formula · {formula.kind.replaceAll("_", " ")} · {PRODUCTION_UNIT_LABELS[formula.unit]}
      </p>
      {quantityFields(formula).map((field) =>
        field.stepper ? (
          <QuantityStepper
            key={field.key}
            id={`${field.key}-${lineItemId}`}
            name={field.key}
            label={field.label}
            value={Number(draftInputs[field.key] ?? 0)}
            onChange={(value) =>
              setDraftInputs((current) => ({ ...current, [field.key]: value }))
            }
          />
        ) : (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={`${field.key}-${lineItemId}`}>{field.label}</Label>
            <Input
              id={`${field.key}-${lineItemId}`}
              inputMode="decimal"
              value={String(draftInputs[field.key] ?? "")}
              onChange={(event) =>
                setDraftInputs((current) => ({
                  ...current,
                  [field.key]: event.target.value,
                }))
              }
            />
          </div>
        ),
      )}
      {rateFields(formula).map((field) => (
        <div key={field.key} className="space-y-1">
          <Label htmlFor={`${field.key}-${lineItemId}`}>{field.label}</Label>
          <Input
            id={`${field.key}-${lineItemId}`}
            inputMode="decimal"
            value={String(draftRates[field.key] ?? "")}
            onChange={(event) => {
              const next = {
                ...draftRates,
                [field.key]: Number(event.target.value) || 0,
              };
              setDraftRates(next);
              persistRates(next);
            }}
            onBlur={() => persistRates(draftRates)}
          />
        </div>
      ))}
      {formula.kind === "tier_table" && formula.tiers?.length ? (
        <ul className="text-xs text-muted-foreground">
          {formula.tiers.map((tier, index) => (
            <li key={`${tier.upTo ?? "open"}-${index}`}>
              {tier.upTo == null ? "Above last tier" : `Up to ${tier.upTo}`} ·{" "}
              {formatMoney(tier.rate)} / {PRODUCTION_UNIT_LABELS[formula.unit]}
            </li>
          ))}
        </ul>
      ) : null}
      <CalculatorBreakdown result={preview} />
      {preview.estimatedLaborHours != null ? (
        <p className="text-xs text-muted-foreground">
          Estimated labor hours (internal): {preview.estimatedLaborHours}
        </p>
      ) : null}
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
      <Button type="submit" disabled={pending || preview.recommendedAmount <= 0}>
        {pending ? "Applying…" : "Apply recommended labor price"}
      </Button>
    </form>
  );
}

function quantityFields(formula: FormulaContract) {
  if (formula.kind === "custom_quote" || formula.kind === "starting_range") return [];
  if (formula.kind === "area") {
    return [
      { key: formula.widthKey ?? "widthFt", label: "Width (ft)", stepper: false },
      { key: formula.heightKey ?? "heightFt", label: "Height (ft)", stepper: false },
      { key: formula.quantityKey ?? "areaSqFt", label: "Area (sf)", stepper: false },
    ];
  }
  if (formula.kind === "linear") {
    return [{ key: formula.quantityKey ?? "lengthLf", label: "Length (lf)", stepper: false }];
  }
  if (formula.kind === "base_plus_components") {
    return (formula.components ?? []).map((component) => ({
      key: component.quantityKey,
      label: component.name,
      stepper: component.unit === "each" || component.unit === "opening",
    }));
  }
  const stepper = formula.kind === "count" || formula.unit === "each" || formula.unit === "opening";
  return [
    {
      key: formula.quantityKey ?? "quantity",
      label: `Quantity (${PRODUCTION_UNIT_LABELS[formula.unit]})`,
      stepper,
    },
  ];
}

function rateFields(formula: FormulaContract) {
  const fields: Array<{ key: string; label: string }> = [];
  if (formula.rateKey) {
    fields.push({
      key: formula.rateKey,
      label: `Rate / ${PRODUCTION_UNIT_LABELS[formula.unit]}`,
    });
  }
  if (formula.minimumKey) fields.push({ key: formula.minimumKey, label: "Minimum" });
  if (formula.baseKey) fields.push({ key: formula.baseKey, label: "Base" });
  if (formula.startingKey) fields.push({ key: formula.startingKey, label: "Starting amount" });
  if (formula.productionPerHourKey) {
    fields.push({
      key: formula.productionPerHourKey,
      label: `${PRODUCTION_UNIT_LABELS[formula.unit]} per hour (internal)`,
    });
  }
  for (const component of formula.components ?? []) {
    fields.push({
      key: component.rateKey,
      label: `${component.name} rate`,
    });
  }
  return fields;
}

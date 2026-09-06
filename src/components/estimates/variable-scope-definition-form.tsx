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
  computeVariableScope,
  persistableVariableScopeRates,
  type VariableScopeComponent,
  type VariableScopeSection,
  type VariableScopeTemplate,
} from "@/lib/estimate-calculators";

const initialState: EstimateActionState = {};

const SECTION_LABELS: Record<VariableScopeSection, string> = {
  measurements: "Measurements / Area",
  counts: "Counted Items",
  allowances: "Allowances / Adjustments",
};

export function VariableScopeDefinitionForm({
  estimateId,
  lineItemId,
  template,
  inputs,
  rates,
}: {
  estimateId: string;
  lineItemId: string;
  template: VariableScopeTemplate;
  inputs?: Record<string, unknown> | null;
  rates?: Record<string, unknown> | null;
}) {
  const [state, action, pending] = useActionState(applyEstimateCalculator, initialState);
  const startingRates = persistableVariableScopeRates(template, rates, inputs);
  const startingInputs = {
    ...Object.fromEntries(
      template.components
        .filter((component) => component.resetQuantity)
        .map((component) => [component.quantityKey ?? component.key, 0]),
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
    () => computeVariableScope(template, draftInputs, draftRates),
    [template, draftInputs, draftRates],
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

  function setQuantity(key: string, value: number) {
    setDraftInputs((current) => ({ ...current, [key]: value }));
  }

  function setRate(key: string, value: number) {
    setDraftRates((current) => ({ ...current, [key]: value }));
  }

  function persistRate(key: string, value: number) {
    const next = { ...draftRates, [key]: value };
    setDraftRates(next);
    persistRates(next);
  }

  const sections = (["measurements", "counts", "allowances"] as const).filter((section) =>
    template.components.some((component) => (component.section ?? "measurements") === section),
  );

  return (
    <form action={action} className="mt-3 space-y-4 rounded-lg border border-border p-3">
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="lineItemId" value={lineItemId} />
      <input type="hidden" name="variableScopePayload" value={payload} />
      <div>
        <p className="text-sm font-medium">Variable-scope labor calculator</p>
        <p className="text-xs text-muted-foreground">
          Owner/internal only. Job quantities stay on this estimate. Edited
          rates save automatically as the business default for future estimates.
        </p>
      </div>
      {sections.map((section) => (
        <fieldset key={section} className="space-y-3">
          <legend className="text-sm font-medium">{SECTION_LABELS[section]}</legend>
          {template.components
            .filter((component) => (component.section ?? "measurements") === section)
            .map((component) => (
              <DefinitionField
                key={component.key}
                component={component}
                quantity={numberFrom(
                  draftInputs[component.quantityKey ?? component.key],
                  component.inputType === "allowance"
                    ? draftRates[component.rateKey ?? component.key] ??
                      component.defaultRate ??
                      0
                    : 0,
                )}
                rate={draftRates[component.rateKey ?? ""] ?? component.defaultRate ?? 0}
                onQuantityChange={setQuantity}
                onRateChange={setRate}
                onRatePersist={persistRate}
              />
            ))}
        </fieldset>
      ))}
      <CalculatorBreakdown result={preview} />
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Applying…" : "Apply recommended labor price"}
      </Button>
    </form>
  );
}

function DefinitionField({
  component,
  quantity,
  rate,
  onQuantityChange,
  onRateChange,
  onRatePersist,
}: {
  component: VariableScopeComponent;
  quantity: number;
  rate: number;
  onQuantityChange: (key: string, value: number) => void;
  onRateChange: (key: string, value: number) => void;
  onRatePersist: (key: string, value: number) => void;
}) {
  const quantityKey = component.quantityKey ?? component.key;
  const rateKey = component.rateKey;
  const units = component.units ? ` (${component.units})` : "";

  if (component.inputType === "count") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <QuantityStepper
          id={`${component.key}-qty`}
          name={quantityKey}
          label={`${component.name}${units}`}
          value={quantity}
          onChange={(value) => onQuantityChange(quantityKey, value)}
        />
        {rateKey ? (
          <RateInput
            id={`${component.key}-rate`}
            label={`${component.name} rate`}
            value={rate}
            onChange={(value) => onRateChange(rateKey, value)}
            onPersist={(value) => onRatePersist(rateKey, value)}
          />
        ) : null}
      </div>
    );
  }

  if (component.inputType === "measurement") {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${component.key}-qty`}>
            {component.name}
            {units}
          </Label>
          <Input
            id={`${component.key}-qty`}
            name={quantityKey}
            type="number"
            min="0"
            step="0.01"
            value={quantity || ""}
            onChange={(event) =>
              onQuantityChange(quantityKey, Number(event.target.value) || 0)
            }
          />
        </div>
        {rateKey ? (
          <RateInput
            id={`${component.key}-rate`}
            label={`${component.name} rate`}
            value={rate}
            onChange={(value) => onRateChange(rateKey, value)}
            onPersist={(value) => onRatePersist(rateKey, value)}
          />
        ) : null}
      </div>
    );
  }

  if (component.inputType === "allowance" && rateKey) {
    return (
      <RateInput
        id={`${component.key}-allowance`}
        label={component.name}
        value={quantity}
        onChange={(value) => {
          onQuantityChange(quantityKey, value);
          onRateChange(rateKey, value);
        }}
        onPersist={(value) => {
          onQuantityChange(quantityKey, value);
          onRatePersist(rateKey, value);
        }}
      />
    );
  }

  if (rateKey) {
    return (
      <RateInput
        id={`${component.key}-rate`}
        label={component.name}
        value={rate}
        onChange={(value) => onRateChange(rateKey, value)}
        onPersist={(value) => onRatePersist(rateKey, value)}
      />
    );
  }

  return null;
}

function RateInput({
  id,
  label,
  value,
  onChange,
  onPersist,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  onPersist: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min="0"
        step="0.01"
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))}
        onBlur={(event) => onPersist(Math.max(0, Number(event.target.value) || 0))}
      />
    </div>
  );
}

function numberFrom(value: unknown, fallback: number) {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

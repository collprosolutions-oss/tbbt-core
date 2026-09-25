/**
 * Estimate-vs-actual semantics.
 *
 * LABOR LineItem.quantity is not estimated hours.
 * LABOR LineItem.total is a customer labor charge, not estimated labor cost.
 * MATERIAL LineItem.total is a customer material charge, not supplier cost.
 *
 * Hours / cost assumptions are used only when a trustworthy snapshot exists
 * (calculator hours keys or takeoff unitCost). Job.scheduledDurationMinutes
 * is planned/scheduled duration, never estimated labor hours.
 */
import { splitLineDescription } from "@/lib/estimate-line-scope";
import { extendedMaterialCost, type TakeoffSnapshot } from "@/lib/material-takeoff/types";
import { roundHours, roundMoney } from "@/lib/time-cards";
import type { FinancialEstimateLine } from "@/lib/financial-intelligence/source";

export const CUSTOMER_LABOR_CHARGE_LABEL = "Customer labor charge / estimated customer price component";
export const CUSTOMER_MATERIAL_CHARGE_LABEL = "Customer material charge";
export const SCHEDULED_DURATION_LABEL = "Planned/scheduled duration";
export const SCHEDULED_DURATION_LIMITATION =
  "Scheduled duration is not crew-adjusted. One scheduled hour is not assumed to equal one labor-hour.";

const HOURS_KEYS = ["estimatedLaborHours", "laborHours", "estimatedHours", "hours"] as const;

export type EstimateLineProvenance =
  | "none"
  | "calculator-hours"
  | "takeoff-unit-cost"
  | "scheduled-duration";

export type CustomerChargeBreakdown = {
  customerLaborCharge: number | null;
  customerMaterialCharge: number | null;
  customerEstimateTotal: number | null;
};

export type CostAssumption = {
  estimatedLaborHours: number | null;
  estimatedLaborHoursProvenance: EstimateLineProvenance;
  estimatedLaborCost: number | null;
  estimatedLaborCostProvenance: EstimateLineProvenance;
  estimatedMaterialCost: number | null;
  estimatedMaterialCostProvenance: EstimateLineProvenance;
  scheduledDurationMinutes: number | null;
};

function numericFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const amount = Number(value);
    if (Number.isFinite(amount) && amount > 0) return amount;
  }
  return null;
}

export function hoursFromCalculatorSnapshot(snapshot: {
  estimatedLaborHours?: number | null;
  result?: { estimatedLaborHours?: number | null } | null;
  inputs?: Record<string, unknown>;
  rates?: Record<string, unknown>;
} | null): number | null {
  if (!snapshot) return null;
  const declared =
    numericFromUnknown(snapshot.estimatedLaborHours) ??
    numericFromUnknown(snapshot.result?.estimatedLaborHours);
  if (declared != null) return declared;
  for (const key of HOURS_KEYS) {
    const fromInputs = numericFromUnknown(snapshot.inputs?.[key]);
    if (fromInputs != null) return fromInputs;
    const fromRates = numericFromUnknown(snapshot.rates?.[key]);
    if (fromRates != null) return fromRates;
  }
  return null;
}

export function materialCostFromTakeoff(snapshot: TakeoffSnapshot | null): number | null {
  if (!snapshot?.items?.length) return null;
  let total = 0;
  let saw = false;
  for (const item of snapshot.items) {
    if (!item.selected) continue;
    if (item.unitCost == null || !Number.isFinite(item.unitCost)) continue;
    total += extendedMaterialCost(item);
    saw = true;
  }
  return saw ? roundMoney(total) : null;
}

export function customerChargesFromLines(lines: readonly FinancialEstimateLine[]): CustomerChargeBreakdown {
  const labor = lines.filter((line) => line.type === "LABOR");
  const materials = lines.filter((line) => line.type === "MATERIAL");
  return {
    customerLaborCharge: labor.length > 0 ? roundMoney(labor.reduce((sum, line) => sum + line.total, 0)) : null,
    customerMaterialCharge: materials.length > 0 ? roundMoney(materials.reduce((sum, line) => sum + line.total, 0)) : null,
    customerEstimateTotal:
      lines.length > 0 ? roundMoney(lines.reduce((sum, line) => sum + line.total, 0)) : null,
  };
}

export function costAssumptionsFromLines(
  lines: readonly FinancialEstimateLine[],
  scheduledDurationMinutes: number | null,
): CostAssumption {
  let estimatedLaborHours: number | null = null;
  let estimatedLaborHoursProvenance: EstimateLineProvenance = "none";
  let estimatedMaterialCost: number | null = null;
  let estimatedMaterialCostProvenance: EstimateLineProvenance = "none";

  for (const line of lines) {
    const split = splitLineDescription(line.description ?? "");
    const hours = hoursFromCalculatorSnapshot(split.calculatorSnapshot);
    if (hours != null) {
      estimatedLaborHours = roundHours((estimatedLaborHours ?? 0) + hours);
      estimatedLaborHoursProvenance = "calculator-hours";
    }
    const takeoffCost = materialCostFromTakeoff(split.materialTakeoff);
    if (takeoffCost != null) {
      estimatedMaterialCost = roundMoney((estimatedMaterialCost ?? 0) + takeoffCost);
      estimatedMaterialCostProvenance = "takeoff-unit-cost";
    }
  }

  return {
    estimatedLaborHours,
    estimatedLaborHoursProvenance,
    estimatedLaborCost: null,
    estimatedLaborCostProvenance: "none",
    estimatedMaterialCost,
    estimatedMaterialCostProvenance,
    scheduledDurationMinutes,
  };
}

export function scheduledDurationHours(minutes: number | null): number | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  return roundHours(minutes / 60);
}

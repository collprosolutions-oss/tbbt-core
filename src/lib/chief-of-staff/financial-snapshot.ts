/**
 * Turn-scoped Financial Intelligence snapshot for Chief of Staff.
 *
 * This is not a general cache. Catalog/BSOS already builds Financial
 * Intelligence when REPORTING_INSIGHTS exists. The Financial specialist
 * reuses that one snapshot instead of loading again.
 */
import type { FinancialIntelligence } from "@/lib/financial-intelligence";

export type FinancialTurnSnapshot = {
  entitled: boolean;
  intelligence: FinancialIntelligence | null;
  failed: boolean;
  failureMessage?: string;
};

export const EMPTY_FINANCIAL_SNAPSHOT: FinancialTurnSnapshot = {
  entitled: false,
  intelligence: null,
  failed: false,
};

let injectedLoadFailure = false;
let specialistInterpretationCount = 0;

export function setInjectedFinancialLoadFailure(value: boolean) {
  injectedLoadFailure = value;
}

export function shouldInjectFinancialLoadFailure() {
  return injectedLoadFailure;
}

export function recordFinancialSpecialistInterpretation() {
  specialistInterpretationCount += 1;
}

export function getFinancialSpecialistInterpretationCount() {
  return specialistInterpretationCount;
}

export function resetFinancialSpecialistCounters() {
  specialistInterpretationCount = 0;
  injectedLoadFailure = false;
}

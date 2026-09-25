/**
 * Catalog form field helpers.
 *
 * HTML checkboxes omit their key when unchecked. An ordinary edit must
 * therefore distinguish "field omitted" (preserve the stored value) from
 * "field submitted off" (disable recurrence).
 *
 * Recurrence eligibility is also trade-gated: a crafted Handyman form
 * cannot store true even if the checkbox is posted.
 */

import { getTradeConfig } from "@/lib/trade-config";

export function catalogRecurrenceEligibleFromForm(
  submitted: boolean,
  checked: boolean,
  existing: boolean,
) {
  return submitted ? checked : existing;
}

export function catalogRecurrenceEligibleForTrade(
  tradeCode: string,
  submitted: boolean,
  checked: boolean,
  existing: boolean,
) {
  if (!getTradeConfig(tradeCode).recurrenceSupport) {
    return false;
  }
  return catalogRecurrenceEligibleFromForm(submitted, checked, existing);
}

export function catalogUnitLabelFromForm(
  pricingMode: string,
  submitted: string,
  existing: string,
) {
  if (pricingMode === "VARIABLE") {
    return submitted;
  }
  return submitted || existing;
}

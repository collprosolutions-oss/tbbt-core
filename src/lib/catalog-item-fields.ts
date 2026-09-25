/**
 * Catalog form field helpers.
 *
 * HTML checkboxes omit their key when unchecked. An ordinary edit must
 * therefore distinguish "field omitted" (preserve the stored value) from
 * "field submitted off" (disable recurrence).
 */

export function catalogRecurrenceEligibleFromForm(
  submitted: boolean,
  checked: boolean,
  existing: boolean,
) {
  return submitted ? checked : existing;
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

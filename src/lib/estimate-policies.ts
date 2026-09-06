/**
 * Configurable customer-facing estimate policy templates.
 *
 * These are business policy/template text, not universal legal advice.
 * Starter wording can be customized per business and is snapshotted onto
 * DRAFT lines. SENT/APPROVED descriptions are never rewritten.
 */
import type { CalculatorCustomerPolicy } from "@/lib/estimate-calculators/types";

export const WORK_AREA_PERSONAL_PROPERTY_POLICY_ID =
  "work-area-personal-property";

export const WORK_AREA_PERSONAL_PROPERTY_TITLE = "Work Area & Personal Property";

export const DEFAULT_WORK_AREA_PERSONAL_PROPERTY_BODY = [
  "Customer is responsible for providing a reasonably clear and accessible work area before work begins. Fragile, valuable, sentimental, irreplaceable, personal, unstable, or easily damaged items should be removed from the work area by the customer.",
  "Construction and renovation activities may create dust and debris. Customer belongings remaining in or near the active work area should be adequately covered or protected. Unless contractor-provided contents protection is specifically included in the estimate, the customer is responsible for removing or protecting belongings from ordinary construction dust and debris.",
  "If the customer requests or permits the contractor to move furniture, décor, appliances, electronics, boxes, or other belongings to gain access to the work area, additional contents-handling labor charges may apply.",
  "If requested, contractor-provided covering/protection of belongings may be added to the estimate for an additional charge. Reasonable protection reduces exposure to construction dust and debris but does not guarantee a completely dust-free environment.",
  "Ordinary project cleanup and debris removal does not include detailed cleaning of customer furniture, décor, electronics, personal belongings, or other contents unless specifically included in the estimate. If additional cleaning of customer belongings is requested or required because belongings remain in the active work area, additional charges may apply.",
  "Customer property handled by the contractor will be handled with reasonable care. Contractor is not responsible for pre-existing damage or damage resulting from fragile, unstable, improperly assembled, concealed, inadequately protected, or inherently delicate items, except to the extent responsibility cannot legally be waived.",
].join("\n\n");

export function defaultWorkAreaPersonalPropertyPolicy(): CalculatorCustomerPolicy {
  return {
    id: WORK_AREA_PERSONAL_PROPERTY_POLICY_ID,
    title: WORK_AREA_PERSONAL_PROPERTY_TITLE,
    body: DEFAULT_WORK_AREA_PERSONAL_PROPERTY_BODY,
  };
}

export function normalizeCustomerPolicies(
  raw?: unknown,
): CalculatorCustomerPolicy[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const policy = item as Record<string, unknown>;
      const id = typeof policy.id === "string" ? policy.id.trim() : "";
      const title = typeof policy.title === "string" ? policy.title.trim() : "";
      const body = typeof policy.body === "string" ? policy.body.trim() : "";
      if (!id || !title || !body) return null;
      return { id, title, body };
    })
    .filter((policy): policy is CalculatorCustomerPolicy => policy != null);
}

export function resolveCustomerPolicies(raw?: unknown): CalculatorCustomerPolicy[] {
  const policies = normalizeCustomerPolicies(raw);
  return policies.length > 0 ? policies : [defaultWorkAreaPersonalPropertyPolicy()];
}

export function uniqueCustomerPolicies(
  groups: Array<CalculatorCustomerPolicy[] | null | undefined>,
): CalculatorCustomerPolicy[] {
  const seen = new Set<string>();
  const next: CalculatorCustomerPolicy[] = [];
  for (const group of groups) {
    for (const policy of group ?? []) {
      if (seen.has(policy.id)) continue;
      seen.add(policy.id);
      next.push(policy);
    }
  }
  return next;
}

/**
 * Deterministic plan identity for historical BusinessSaasSubscription
 * rows that have no planCode.
 *
 * Every pre-catalog SaaS row is a Founder-era record. Unknown stored
 * codes and unknown Stripe price IDs never become Business/Enterprise.
 */
import {
  canonicalizePlanCode,
  PLAN_CODES,
  type PlanCode,
} from "@/lib/product-catalog/codes";

export type CompatiblePlanInput = {
  planCode?: string | null;
  stripePriceId?: string | null;
  founderEligible?: boolean | null;
  founderConvertedAt?: Date | string | null;
  trialStartedAt?: Date | string | null;
  legacyExempt?: boolean | null;
  resolvePricePlanCode?: (priceId: string | null | undefined) => PlanCode | null;
};

export function resolveCompatiblePlanCode(input: CompatiblePlanInput): PlanCode {
  const stored = canonicalizePlanCode(input.planCode);
  if (stored) return stored;

  const fromPrice = input.resolvePricePlanCode?.(input.stripePriceId ?? null) ?? null;
  if (fromPrice) return fromPrice;

  return PLAN_CODES.FOUNDER;
}

export function describeCompatiblePlanRule() {
  return [
    "Stored planCode wins when it is a known catalog code or tbbt_founder alias.",
    "A known configured Stripe price maps to that plan.",
    "Unknown stored codes and unknown prices never grant a higher plan.",
    "Historical rows without planCode resolve to FOUNDER (Founder-era SaaS).",
    "CollPro / legacy-exempt tenants keep Founder-level product capabilities.",
  ].join(" ");
}

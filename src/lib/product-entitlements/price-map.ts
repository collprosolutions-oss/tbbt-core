/**
 * Server-owned Stripe Price → plan mapping.
 *
 * The browser may request a plan code only. The server supplies the
 * Price ID. Unknown webhook price IDs never grant a higher plan.
 *
 * STRIPE_SAAS_PRICE_ID remains the Founder price (backward compatible).
 * Optional per-plan env vars and STRIPE_SAAS_PLAN_PRICE_MAP can add
 * approved prices later without redesigning the application.
 */
import {
  canonicalizePlanCode,
  isPlanCode,
  PLAN_CODE_LIST,
  PLAN_CODES,
  type PlanCode,
} from "@/lib/product-catalog/codes";
import { PLAN_DEFINITIONS } from "@/lib/product-catalog/plans";
import { getSaasPriceId, isFakeSaasBillingAdapterEnabled } from "@/lib/saas-billing/config";

export const FAKE_FOUNDER_PRICE_ID = "price_saas_test";

function parsePlanPriceMap(): Partial<Record<PlanCode, string>> {
  const raw = process.env.STRIPE_SAAS_PLAN_PRICE_MAP?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const mapped: Partial<Record<PlanCode, string>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const code = canonicalizePlanCode(key);
      if (code && typeof value === "string" && value.trim()) {
        mapped[code] = value.trim();
      }
    }
    return mapped;
  } catch {
    return {};
  }
}

export function getConfiguredPlanPriceId(planCode: PlanCode): string | null {
  if (planCode === PLAN_CODES.FOUNDER) {
    return getSaasPriceId();
  }
  const fromNamedEnv = process.env[`STRIPE_SAAS_PRICE_ID_${planCode}`]?.trim();
  if (fromNamedEnv) return fromNamedEnv;
  const fromMap = parsePlanPriceMap()[planCode];
  return fromMap ?? null;
}

export function fakePriceIdForPlan(planCode: PlanCode) {
  if (planCode === PLAN_CODES.FOUNDER) return FAKE_FOUNDER_PRICE_ID;
  return `price_saas_test_${planCode}`;
}

export function resolveCheckoutPriceId(planCode: PlanCode): string | null {
  const configured = getConfiguredPlanPriceId(planCode);
  if (configured) return configured;
  if (isFakeSaasBillingAdapterEnabled()) {
    return fakePriceIdForPlan(planCode);
  }
  return null;
}

export function resolvePlanCodeFromPriceId(priceId: string | null | undefined): PlanCode | null {
  if (!priceId) return null;
  // Test adapter identities only. Production-shaped environments must
  // never treat price_saas_test* as a paid plan unless that exact ID is
  // an explicitly configured approved price.
  if (isFakeSaasBillingAdapterEnabled()) {
    if (priceId === FAKE_FOUNDER_PRICE_ID || priceId === "price_saas_test_FOUNDER") {
      return PLAN_CODES.FOUNDER;
    }
    const fakeMatch = /^price_saas_test_([A-Z]+)$/.exec(priceId);
    if (fakeMatch && isPlanCode(fakeMatch[1])) {
      return fakeMatch[1];
    }
  }
  for (const code of PLAN_CODE_LIST) {
    const configured = getConfiguredPlanPriceId(code);
    if (configured && configured === priceId) return code;
  }
  return null;
}

/**
 * Unknown prices keep the current plan. They never upgrade.
 */
export function resolveWebhookPlanCode(input: {
  stripePriceId: string | null | undefined;
  currentPlanCode?: string | null;
}): PlanCode {
  const mapped = resolvePlanCodeFromPriceId(input.stripePriceId ?? null);
  if (mapped) return mapped;
  return canonicalizePlanCode(input.currentPlanCode) ?? PLAN_CODES.FOUNDER;
}

export function listConfiguredPlanPrices() {
  return PLAN_CODE_LIST.map((code) => ({
    planCode: code,
    priceId: getConfiguredPlanPriceId(code),
    checkoutEligible: PLAN_DEFINITIONS[code].checkoutEligible,
    envKeys: PLAN_DEFINITIONS[code].stripePriceEnvKeys,
  }));
}

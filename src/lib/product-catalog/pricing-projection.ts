/**
 * Marketing pricing page projection of the authoritative catalog.
 * The page must not keep a second feature list.
 */
import { listAddonDefinitions } from "@/lib/product-catalog/addons";
import { PRODUCT_CAPABILITY_DEFINITIONS } from "@/lib/product-catalog/capabilities";
import {
  PLAN_CODES,
  PLAN_PUBLIC_STATUSES,
  type PlanCode,
} from "@/lib/product-catalog/codes";
import { PRICING_COMPARE_ROWS } from "@/lib/product-catalog/compare";
import { listPlanDefinitions, PLAN_DEFINITIONS } from "@/lib/product-catalog/plans";

export const PRICING_COMING_SOON_LABEL = "Coming Soon";
export const PRICING_PLANNED_LABEL = "Planned";
export const PRICING_AVAILABLE_NOW_LABEL = "Available Now";
export const PRICING_ADDON_PRICE_LABEL = "Pricing to be announced";

export type PricingPlanCardProjection = {
  code: PlanCode;
  displayName: string;
  headingName: string;
  tagline: string;
  publicStatus: string;
  statusBadge: string | null;
  plannedLabel: string | null;
  priceLabel: string | null;
  priceAmount: string | null;
  priceSuffix: string | null;
  founderPriceLabel: string | null;
  cardFeatures: readonly string[];
  cta: "SIGN_UP" | "CONTACT" | "SOON";
  purchasable: boolean;
  checkoutEligible: boolean;
  featured: boolean;
};

export type PricingAddonProjection = {
  code: string;
  title: string;
  icon: "trade" | "sms" | "coach" | "users" | "storage" | "domain";
  status: string;
  price: string;
  purchasable: boolean;
};

export type PricingPageProjection = {
  plans: PricingPlanCardProjection[];
  compareRows: typeof PRICING_COMPARE_ROWS;
  addons: PricingAddonProjection[];
  founderCardFeatures: readonly string[];
  starterCardFeatures: readonly string[];
  businessCardFeatures: readonly string[];
  enterpriseCardFeatures: readonly string[];
};

function statusBadge(code: PlanCode) {
  const plan = PLAN_DEFINITIONS[code];
  if (plan.publicStatus === PLAN_PUBLIC_STATUSES.LIVE) return PRICING_AVAILABLE_NOW_LABEL;
  return PRICING_COMING_SOON_LABEL;
}

function plannedLabel(code: PlanCode) {
  const plan = PLAN_DEFINITIONS[code];
  if (plan.publicStatus === PLAN_PUBLIC_STATUSES.LIVE) return null;
  return PRICING_PLANNED_LABEL;
}

function projectPlan(code: PlanCode): PricingPlanCardProjection {
  const plan = PLAN_DEFINITIONS[code];
  const live = plan.publicStatus === PLAN_PUBLIC_STATUSES.LIVE;
  return {
    code,
    displayName: plan.displayName,
    headingName: plan.displayName.replace(" Plan", ""),
    tagline: plan.tagline,
    publicStatus: plan.publicStatus,
    statusBadge: live ? PRICING_AVAILABLE_NOW_LABEL : PRICING_COMING_SOON_LABEL,
    plannedLabel: plannedLabel(code),
    priceLabel: plan.approvedDisplayPrice?.label ?? null,
    priceAmount: plan.approvedDisplayPrice ? "$49" : null,
    priceSuffix: plan.approvedDisplayPrice ? "/month" : null,
    founderPriceLabel: code === PLAN_CODES.FOUNDER ? plan.approvedDisplayPrice?.label ?? null : null,
    cardFeatures: plan.cardFeatures.map((feature) => feature.label),
    cta: code === PLAN_CODES.ENTERPRISE ? "CONTACT" : live ? "SIGN_UP" : "SOON",
    purchasable: live && plan.checkoutEligible && plan.approvedDisplayPrice != null,
    checkoutEligible: plan.checkoutEligible,
    featured: code === PLAN_CODES.FOUNDER,
  };
}

export function getPricingPageProjection(): PricingPageProjection {
  const plans = listPlanDefinitions().map((plan) => projectPlan(plan.code));
  const byCode = Object.fromEntries(plans.map((plan) => [plan.code, plan])) as Record<
    PlanCode,
    PricingPlanCardProjection
  >;
  return {
    plans,
    compareRows: PRICING_COMPARE_ROWS,
    addons: listAddonDefinitions().map((addon) => ({
      code: addon.code,
      title: addon.displayName,
      icon: addon.icon,
      status: PRICING_COMING_SOON_LABEL,
      price: PRICING_ADDON_PRICE_LABEL,
      purchasable: false,
    })),
    founderCardFeatures: byCode.FOUNDER.cardFeatures,
    starterCardFeatures: byCode.STARTER.cardFeatures,
    businessCardFeatures: byCode.BUSINESS.cardFeatures,
    enterpriseCardFeatures: byCode.ENTERPRISE.cardFeatures,
  };
}

export function listLiveSoftwareCardFeatures(code: PlanCode) {
  return PLAN_DEFINITIONS[code].cardFeatures.filter((feature) => {
    if (feature.kind !== "CAPABILITY" || !feature.capability) return feature.liveSoftware;
    const implementation = PRODUCT_CAPABILITY_DEFINITIONS[feature.capability].implementationStatus;
    return feature.liveSoftware && implementation !== "COMING_SOON" && implementation !== "PLANNED";
  });
}

export { statusBadge };

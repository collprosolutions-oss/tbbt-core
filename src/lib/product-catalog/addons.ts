/**
 * Optional add-ons are independent entitlement sources.
 * They never mutate the base plan definition.
 *
 * None are purchasable until an approved price/provider exists.
 * Fake/test mode may assign them to prove the resolver.
 */
import {
  ADDON_CODES,
  ADDON_CODE_LIST,
  PLAN_PUBLIC_STATUSES,
  PRODUCT_CAPABILITIES,
  PRODUCT_LIMITS,
  type AddonCode,
  type PlanPublicStatus,
  type ProductCapabilityCode,
  type ProductLimitCode,
} from "@/lib/product-catalog/codes";

export type AddonDefinition = {
  code: AddonCode;
  displayName: string;
  publicStatus: PlanPublicStatus;
  checkoutEligible: boolean;
  approvedDisplayPrice: null;
  icon: "trade" | "sms" | "coach" | "users" | "storage" | "domain";
  grantsCapabilities: readonly ProductCapabilityCode[];
  /**
   * Additive limit deltas. null means the architecture accepts a later
   * approved quantity without inventing one now.
   */
  limitDeltas: Partial<Record<ProductLimitCode, number | null>>;
};

export const ADDON_DEFINITIONS: Record<AddonCode, AddonDefinition> = {
  [ADDON_CODES.ADDITIONAL_TRADE]: {
    code: ADDON_CODES.ADDITIONAL_TRADE,
    displayName: "Additional Trade",
    publicStatus: PLAN_PUBLIC_STATUSES.COMING_SOON,
    checkoutEligible: false,
    approvedDisplayPrice: null,
    icon: "trade",
    grantsCapabilities: [PRODUCT_CAPABILITIES.MULTI_TRADE],
    limitDeltas: { [PRODUCT_LIMITS.TRADES]: 1 },
  },
  [ADDON_CODES.SMS_MESSAGING]: {
    code: ADDON_CODES.SMS_MESSAGING,
    displayName: "SMS Messaging",
    publicStatus: PLAN_PUBLIC_STATUSES.COMING_SOON,
    checkoutEligible: false,
    approvedDisplayPrice: null,
    icon: "sms",
    grantsCapabilities: [PRODUCT_CAPABILITIES.SMS_MESSAGING],
    limitDeltas: {},
  },
  [ADDON_CODES.AI_BUSINESS_COACH]: {
    code: ADDON_CODES.AI_BUSINESS_COACH,
    displayName: "AI Business Coach",
    publicStatus: PLAN_PUBLIC_STATUSES.COMING_SOON,
    checkoutEligible: false,
    approvedDisplayPrice: null,
    icon: "coach",
    grantsCapabilities: [PRODUCT_CAPABILITIES.AI_BUSINESS_COACH],
    limitDeltas: {},
  },
  [ADDON_CODES.ADDITIONAL_USERS]: {
    code: ADDON_CODES.ADDITIONAL_USERS,
    displayName: "Additional Users",
    publicStatus: PLAN_PUBLIC_STATUSES.COMING_SOON,
    checkoutEligible: false,
    approvedDisplayPrice: null,
    icon: "users",
    grantsCapabilities: [],
    limitDeltas: { [PRODUCT_LIMITS.USERS]: null },
  },
  [ADDON_CODES.EXTRA_STORAGE]: {
    code: ADDON_CODES.EXTRA_STORAGE,
    displayName: "Extra Storage",
    publicStatus: PLAN_PUBLIC_STATUSES.COMING_SOON,
    checkoutEligible: false,
    approvedDisplayPrice: null,
    icon: "storage",
    grantsCapabilities: [PRODUCT_CAPABILITIES.EXTRA_STORAGE],
    limitDeltas: { [PRODUCT_LIMITS.STORAGE_BYTES]: null },
  },
  [ADDON_CODES.BUSINESS_EMAIL]: {
    code: ADDON_CODES.BUSINESS_EMAIL,
    displayName: "Business Email",
    publicStatus: PLAN_PUBLIC_STATUSES.COMING_SOON,
    checkoutEligible: false,
    approvedDisplayPrice: null,
    icon: "domain",
    grantsCapabilities: [PRODUCT_CAPABILITIES.BUSINESS_EMAIL],
    limitDeltas: {},
  },
};

export function getAddonDefinition(code: AddonCode) {
  return ADDON_DEFINITIONS[code];
}

export function listAddonDefinitions() {
  return ADDON_CODE_LIST.map((code) => ADDON_DEFINITIONS[code]);
}

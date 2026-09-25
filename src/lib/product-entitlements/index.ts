export { describeCompatiblePlanRule, resolveCompatiblePlanCode } from "@/lib/product-entitlements/compatibility";
export {
  FAKE_FOUNDER_PRICE_ID,
  fakePriceIdForPlan,
  getConfiguredPlanPriceId,
  listConfiguredPlanPrices,
  resolveCheckoutPriceId,
  resolvePlanCodeFromPriceId,
  resolveWebhookPlanCode,
} from "@/lib/product-entitlements/price-map";
export {
  PRODUCT_DOWNGRADE_POLICY,
  PRODUCT_DOWNGRADE_RULES,
} from "@/lib/product-entitlements/downgrade";
export {
  ProductCapabilityRequiredError,
  ProductLimitExceededError,
  productEntitlementErrorMessage,
} from "@/lib/product-entitlements/errors";
export {
  capabilitySourcesFor,
  DEFAULT_COMPATIBILITY_PLAN,
  describeCapability,
  hasResolvedProductCapability,
  resolveProductEntitlement,
  resolveProductLimitValue,
} from "@/lib/product-entitlements/resolver";
export type {
  CapabilitySource,
  EntitlementSourceKind,
  ProductEntitlement,
  ResolvedLimit,
  ResolvedProductAddon,
} from "@/lib/product-entitlements/resolver";
export {
  hasProductCapability,
  loadProductEntitlement,
  requireOperatingProductCapability,
  requireProductCapability,
  requireProductLimitAllows,
  resolveProductLimit,
  assertProductLimitAllows,
} from "@/lib/product-entitlements/enforce";
export {
  assignProductAddon,
  listBusinessProductAddons,
  revokeProductAddon,
} from "@/lib/product-entitlements/addons";
export {
  grantProductCapability,
  grantProductLimit,
  revokeProductGrant,
} from "@/lib/product-entitlements/grants";
export {
  assertMemberInviteAllowed,
  assertTradeActivationAllowed,
  countActiveMembers,
  countActiveTrades,
  describeLimitArchitecture,
  resolveEffectiveStorageLimitBytes,
  storageLimitBlocksIncoming,
} from "@/lib/product-entitlements/limits";

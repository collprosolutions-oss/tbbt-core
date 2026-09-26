/**
 * Owner Integration Center types.
 *
 * Status is never stored here. Canonical health comes from Go-live
 * classifiers (`src/lib/go-live.ts`). This module only describes the
 * first-party integrations TBBT can actually use.
 */
import type { GoLiveCapabilityId, GoLiveRequirement, GoLiveStatus } from "@/lib/go-live";
import type {
  CapabilityImplementationStatus,
  ProductCapabilityCode,
} from "@/lib/product-catalog/codes";

export const INTEGRATION_CENTER_PATH = "/integrations";

export const INTEGRATION_CATEGORIES = [
  "Payments",
  "Communications",
  "Storage",
  "Calendar",
  "Accounting",
  "Financial",
  "Documents/e-sign",
  "Materials/Suppliers",
  "Website/Domain",
  "AI",
] as const;

export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export function isIntegrationCategory(value: string): value is IntegrationCategory {
  return (INTEGRATION_CATEGORIES as readonly string[]).includes(value);
}

export type IntegrationDefinition = {
  key: string;
  displayName: string;
  category: IntegrationCategory;
  requirement: GoLiveRequirement;
  /** Existing Go-live capability whose classifier owns status. */
  goLiveCapabilityId: GoLiveCapabilityId;
  productCapability?: ProductCapabilityCode;
  description: string;
  settingsHref: string;
};

export type IntegrationEntitlementTruth = {
  capability: ProductCapabilityCode;
  entitled: boolean;
  label: string;
  implementationStatus: CapabilityImplementationStatus;
  note: string;
};

export type IntegrationCard = {
  key: string;
  displayName: string;
  category: IntegrationCategory;
  requirement: GoLiveRequirement;
  requirementLabel: string;
  status: GoLiveStatus;
  statusLabel: string;
  description: string;
  currentState: string;
  whatWorks: string;
  whatDoesNot: string;
  ownerNextAction: string;
  settingsHref: string;
  entitlement: IntegrationEntitlementTruth | null;
};

export type IntegrationCategoryGroup = {
  id: IntegrationCategory;
  items: IntegrationCard[];
};

export type IntegrationCenter = {
  businessId: string;
  planName: string;
  planCode: string;
  readOnly: true;
  items: IntegrationCard[];
  categories: IntegrationCategoryGroup[];
  disclaimer: string;
};

export type IntegrationEntitlementInput = {
  businessId: string;
  planCode: string;
  planName: string;
  capabilities: readonly string[];
};

export type UnsupportedIntegration = {
  key: string;
  category: IntegrationCategory;
  reason: string;
  goLiveCapabilityId?: GoLiveCapabilityId;
};

export const INTEGRATION_CENTER_DISCLAIMER =
  "This center lists integrations TBBT can actually use today. Status comes from the existing Go-live health classifiers. It does not connect providers, change DNS, start OAuth, or change billing.";

export const INTEGRATION_CENTER_READ_ONLY_MESSAGE =
  "Read-only configuration truth for the authenticated business. API keys, webhook secrets, tokens, and connection strings are never shown.";

/**
 * Projects the owner Integration Center from the existing Go-live health
 * board plus recorded product entitlements.
 *
 * This is not a second health engine. Status, current state, and next
 * actions are copied from Go-live cards produced by `buildGoLiveCenter`.
 */
import {
  assertGoLiveProjectionSafe,
  GO_LIVE_PATH,
  GO_LIVE_REQUIREMENT_LABELS,
  GO_LIVE_STATUS_LABELS,
  goLiveCardById,
  type GoLiveCenter,
} from "@/lib/go-live";
import { getProductCapabilityDefinition } from "@/lib/product-catalog/capabilities";
import { isProductCapabilityCode } from "@/lib/product-catalog/codes";
import {
  composeIntegrationRegistry,
  INTEGRATION_REGISTRY,
} from "@/lib/integrations/registry";
import {
  INTEGRATION_CENTER_DISCLAIMER,
  type IntegrationCard,
  type IntegrationCategory,
  type IntegrationCenter,
  type IntegrationDefinition,
  type IntegrationEntitlementInput,
  type IntegrationEntitlementTruth,
} from "@/lib/integrations/types";

export { GO_LIVE_PATH };

export function buildIntegrationCenter(input: {
  businessId: string;
  goLive: GoLiveCenter;
  entitlement: IntegrationEntitlementInput;
  registry?: readonly IntegrationDefinition[];
}): IntegrationCenter {
  const registry = input.registry ?? INTEGRATION_REGISTRY;
  const items = registry.map((definition) =>
    projectIntegrationCard(definition, input.goLive, input.entitlement),
  );
  const categories = groupByCategory(items);
  const center: IntegrationCenter = {
    businessId: input.businessId,
    planName: input.entitlement.planName,
    planCode: input.entitlement.planCode,
    readOnly: true,
    items,
    categories,
    disclaimer: INTEGRATION_CENTER_DISCLAIMER,
  };
  assertGoLiveProjectionSafe(center);
  return center;
}

export function projectIntegrationCard(
  definition: IntegrationDefinition,
  goLive: GoLiveCenter,
  entitlement: IntegrationEntitlementInput,
): IntegrationCard {
  const health = goLiveCardById(goLive, definition.goLiveCapabilityId);
  if (!health) {
    throw new Error(
      `Go-live has no card for ${definition.goLiveCapabilityId}; Integration Center will not invent a status.`,
    );
  }
  return {
    key: definition.key,
    displayName: definition.displayName,
    category: definition.category,
    requirement: definition.requirement,
    requirementLabel: GO_LIVE_REQUIREMENT_LABELS[definition.requirement],
    status: health.status,
    statusLabel: GO_LIVE_STATUS_LABELS[health.status],
    description: definition.description,
    currentState: health.currentState,
    whatWorks: health.whatWorks,
    whatDoesNot: health.whatDoesNot,
    ownerNextAction: health.ownerNextAction,
    settingsHref: definition.settingsHref || health.settingsHref,
    entitlement: entitlementTruth(definition, entitlement),
  };
}

function entitlementTruth(
  definition: IntegrationDefinition,
  entitlement: IntegrationEntitlementInput,
): IntegrationEntitlementTruth | null {
  if (!definition.productCapability) return null;
  const capability = definition.productCapability;
  if (!isProductCapabilityCode(capability)) return null;
  const definitionMeta = getProductCapabilityDefinition(capability);
  return {
    capability,
    entitled: entitlement.capabilities.includes(capability),
    label: definitionMeta.displayName,
    implementationStatus: definitionMeta.implementationStatus,
    note: definitionMeta.enforcementNotes,
  };
}

function groupByCategory(items: IntegrationCard[]) {
  const order: IntegrationCategory[] = [];
  const map = new Map<IntegrationCategory, IntegrationCard[]>();
  for (const item of items) {
    if (!map.has(item.category)) {
      map.set(item.category, []);
      order.push(item.category);
    }
    map.get(item.category)?.push(item);
  }
  return order.map((id) => ({ id, items: map.get(id) ?? [] }));
}

export function integrationCenterWithFutureProvider(
  input: {
    businessId: string;
    goLive: GoLiveCenter;
    entitlement: IntegrationEntitlementInput;
  },
  future: IntegrationDefinition,
) {
  return buildIntegrationCenter({
    ...input,
    registry: composeIntegrationRegistry([future]),
  });
}

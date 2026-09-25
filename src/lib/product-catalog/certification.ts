/**
 * Machine-readable plan certification for later PR #112 and the
 * marketing-truth test in this PR.
 *
 * Green checks are only emitted when the catalog says the plan includes
 * the capability. Implementation status is a separate field so unbuilt
 * features cannot be certified as live software.
 */
import { PRODUCT_CAPABILITY_DEFINITIONS } from "@/lib/product-catalog/capabilities";
import {
  PLAN_CODE_LIST,
  PLAN_PUBLIC_STATUSES,
  PRODUCT_CAPABILITIES,
  type PlanCode,
  type ProductCapabilityCode,
} from "@/lib/product-catalog/codes";
import { PRICING_COMPARE_ROWS } from "@/lib/product-catalog/compare";
import {
  PLAN_DEFINITIONS,
  planIncludesCapability,
  type PlanDefinition,
} from "@/lib/product-catalog/plans";
import { listAddonDefinitions } from "@/lib/product-catalog/addons";
import { getPricingPageProjection } from "@/lib/product-catalog/pricing-projection";

export type PlanCertificationFeature = {
  compareId: string;
  label: string;
  kind: "PLAN_STATUS" | "CAPABILITY" | "SERVICE";
  capability: string | null;
  implementationStatus: string | null;
  enforcementBoundary: boolean;
  claimedByPlan: Record<PlanCode, boolean | string>;
  presentedAsLiveSoftware: Record<PlanCode, boolean>;
};

export type PlanLaunchReadinessFinding = {
  planCode: PlanCode;
  severity: "BLOCKER";
  code: string;
  advertisedCapability: ProductCapabilityCode;
  dependsOnCapability: ProductCapabilityCode;
  reason: string;
};

export type PlanLaunchReadiness = {
  planCode: PlanCode;
  launchReady: boolean;
  findings: PlanLaunchReadinessFinding[];
};

/**
 * Advertised capabilities that cannot currently operate together unless
 * a required sibling capability is also included. This is a launch
 * gate, not a green-check rewrite. Do not treat capability-code
 * presence alone as LIVE-ready.
 */
export const PLAN_LAUNCH_WORKFLOW_DEPENDENCIES = [
  {
    advertisedCapability: PRODUCT_CAPABILITIES.SCHEDULING,
    dependsOnCapability: PRODUCT_CAPABILITIES.JOBS_TASKS,
    code: "SCHEDULING_REQUIRES_JOBS",
    reason:
      "Current TBBT scheduling is Job-based. A plan that advertises Scheduling & Calendar without JOBS_TASKS cannot operate that workflow until a separate non-job calendar exists or JOBS_TASKS is included.",
  },
  {
    advertisedCapability: PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
    dependsOnCapability: PRODUCT_CAPABILITIES.JOBS_TASKS,
    code: "INVOICES_REQUIRE_COMPLETED_JOB",
    reason:
      "Current invoice creation is from a completed Job. A plan that advertises Estimates & Invoices without JOBS_TASKS cannot complete that workflow until a separate non-job invoice path exists or JOBS_TASKS is included.",
  },
] as const;

export function getPlanLaunchReadiness(code: PlanCode): PlanLaunchReadiness {
  const findings: PlanLaunchReadinessFinding[] = [];
  for (const dependency of PLAN_LAUNCH_WORKFLOW_DEPENDENCIES) {
    if (
      planIncludesCapability(code, dependency.advertisedCapability) &&
      !planIncludesCapability(code, dependency.dependsOnCapability)
    ) {
      findings.push({
        planCode: code,
        severity: "BLOCKER",
        code: dependency.code,
        advertisedCapability: dependency.advertisedCapability,
        dependsOnCapability: dependency.dependsOnCapability,
        reason: dependency.reason,
      });
    }
  }
  return {
    planCode: code,
    launchReady: findings.length === 0,
    findings,
  };
}

export type PlanCertificationProjection = {
  plans: Array<{
    code: PlanCode;
    displayName: string;
    publicStatus: string;
    checkoutEligible: boolean;
    purchasableWithoutPriceConfig: boolean;
    approvedDisplayPrice: PlanDefinition["approvedDisplayPrice"];
    capabilities: string[];
    launchReady: boolean;
    launchBlockers: PlanLaunchReadinessFinding[];
  }>;
  features: PlanCertificationFeature[];
  addons: Array<{
    code: string;
    displayName: string;
    purchasable: boolean;
    publicStatus: string;
  }>;
  pricingProjectionAligned: boolean;
};

export function getPlanCertificationProjection(): PlanCertificationProjection {
  const pricing = getPricingPageProjection();
  return {
    plans: PLAN_CODE_LIST.map((code) => {
      const plan = PLAN_DEFINITIONS[code];
      const launch = getPlanLaunchReadiness(code);
      return {
        code,
        displayName: plan.displayName,
        publicStatus: plan.publicStatus,
        checkoutEligible: plan.checkoutEligible,
        purchasableWithoutPriceConfig: false,
        approvedDisplayPrice: plan.approvedDisplayPrice,
        capabilities: [...plan.cardFeatures]
          .map((feature) => feature.capability)
          .filter((value): value is NonNullable<typeof value> => Boolean(value)),
        launchReady: launch.launchReady,
        launchBlockers: launch.findings,
      };
    }),
    features: PRICING_COMPARE_ROWS.map((row) => {
      const definition = row.capability ? PRODUCT_CAPABILITY_DEFINITIONS[row.capability] : null;
      const claimedByPlan = {
        STARTER: row.values[0] === "check" || (row.kind === "PLAN_STATUS" ? row.values[0] : false),
        FOUNDER: row.values[1] === "check" || (row.kind === "PLAN_STATUS" ? row.values[1] : false),
        BUSINESS: row.values[2] === "check" || (row.kind === "PLAN_STATUS" ? row.values[2] : false),
        ENTERPRISE: row.values[3] === "check" || (row.kind === "PLAN_STATUS" ? row.values[3] : false),
      } as Record<PlanCode, boolean | string>;
      const presentedAsLiveSoftware = {
        STARTER: Boolean(
          row.capability &&
            row.values[0] === "check" &&
            definition?.implementationStatus === "LIVE",
        ),
        FOUNDER: Boolean(
          row.capability &&
            row.values[1] === "check" &&
            definition?.implementationStatus === "LIVE",
        ),
        BUSINESS: Boolean(
          row.capability &&
            row.values[2] === "check" &&
            definition?.implementationStatus === "LIVE" &&
            PLAN_DEFINITIONS.BUSINESS.publicStatus === PLAN_PUBLIC_STATUSES.LIVE,
        ),
        ENTERPRISE: Boolean(
          row.capability &&
            row.values[3] === "check" &&
            definition?.implementationStatus === "LIVE" &&
            PLAN_DEFINITIONS.ENTERPRISE.publicStatus === PLAN_PUBLIC_STATUSES.LIVE,
        ),
      };
      if (row.capability) {
        for (const code of PLAN_CODE_LIST) {
          claimedByPlan[code] = planIncludesCapability(code, row.capability);
        }
      }
      return {
        compareId: row.id,
        label: row.label,
        kind: row.kind,
        capability: row.capability ?? null,
        implementationStatus: definition?.implementationStatus ?? null,
        enforcementBoundary: definition?.enforcementBoundary ?? false,
        claimedByPlan,
        presentedAsLiveSoftware,
      };
    }),
    addons: listAddonDefinitions().map((addon) => ({
      code: addon.code,
      displayName: addon.displayName,
      purchasable: false,
      publicStatus: addon.publicStatus,
    })),
    pricingProjectionAligned: pricing.compareRows === PRICING_COMPARE_ROWS,
  };
}

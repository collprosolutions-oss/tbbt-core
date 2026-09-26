/**
 * TypeScript specialist registry. Not a Prisma table.
 * Disabled specialists must never trigger deep department reads.
 */
import { CAPABILITIES, type Capability } from "@/lib/authorization";
import type { ApprovalClass, SpecialistId } from "@/lib/chief-of-staff/types";
import { COS_APPROVAL_CLASS } from "@/lib/chief-of-staff/types";

export type SpecialistRegistryEntry = {
  id: SpecialistId;
  purpose: string;
  enabled: boolean;
  requiredRoleCapability: Capability;
  requiredProductCapability: string | null;
  readScope: string;
  approvalClass: ApprovalClass;
  forbiddenBehavior: string[];
  deepLoader: string | null;
};

export const SPECIALIST_REGISTRY: readonly SpecialistRegistryEntry[] = [
  {
    id: "ATTENTION",
    purpose: "Project existing BSOS attention facts already loaded for Business Health.",
    enabled: true,
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: null,
    readScope: "bsos-facts",
    approvalClass: COS_APPROVAL_CLASS,
    forbiddenBehavior: [
      "invoke-specialist",
      "mutate-domain",
      "send-communications",
      "authorize",
    ],
    deepLoader: null,
  },
  {
    id: "WORKFORCE",
    purpose:
      "Explain schedule, capacity, assignment, and conflict facts from the existing Workforce snapshot already loaded for the canonical catalog. Read/explain only.",
    enabled: true,
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: null,
    readScope: "workforce-schedule-capacity",
    approvalClass: COS_APPROVAL_CLASS,
    forbiddenBehavior: [
      "invoke-specialist",
      "assign-workers",
      "change-schedules",
      "create-outreach",
      "send-communications",
      "write-availability",
      "mutate-domain",
      "authorize",
    ],
    deepLoader: null,
  },
  {
    id: "FINANCIAL",
    purpose: "Read/explain recorded Financial Intelligence. Not a second finance engine.",
    enabled: true,
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: "REPORTING_INSIGHTS",
    readScope: "financial-intelligence",
    approvalClass: COS_APPROVAL_CLASS,
    forbiddenBehavior: [
      "invoke-specialist",
      "write-payments",
      "mark-paid",
      "write-expenses",
      "save-labor-burden",
      "mutate-recurring-expenses",
      "write-pricing",
      "write-estimates",
      "write-invoices",
      "propose-ai-action",
      "authorize",
    ],
    deepLoader: "financial-turn-snapshot",
  },
  {
    id: "GROWTH",
    purpose:
      "Explain recorded lead/revenue funnel, recovery, reactivation, campaign/source performance, and existing Growth recommendations. Read/explain only. Not a second Growth engine.",
    enabled: true,
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: "MARKETING_TOOLS",
    readScope: "growth-department",
    approvalClass: COS_APPROVAL_CLASS,
    forbiddenBehavior: [
      "invoke-specialist",
      "send-communications",
      "create-growth-action",
      "create-campaign",
      "modify-customers",
      "change-consent",
      "auto-reactivate",
      "auto-request-reviews",
      "write-recommendations",
      "propose-ai-action",
      "authorize",
    ],
    deepLoader: "growth-turn-snapshot",
  },
  {
    id: "KNOWLEDGE_LAUNCH",
    purpose:
      "Explain recorded Knowledge Hub and Business Launch truth. Read/explain only. Not a second Knowledge engine, second Launch engine, or new business setup system.",
    enabled: true,
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: null,
    readScope: "knowledge-launch",
    approvalClass: COS_APPROVAL_CLASS,
    forbiddenBehavior: [
      "invoke-specialist",
      "create-knowledge",
      "edit-knowledge",
      "approve-knowledge",
      "reject-knowledge",
      "archive-knowledge",
      "mark-knowledge-reviewed",
      "create-experience-candidate",
      "promote-experience-candidate",
      "write-operating-procedure",
      "mutate-launch-progress",
      "complete-launch-step",
      "skip-launch-step",
      "defer-launch-step",
      "change-business-settings",
      "change-pricing",
      "enable-trades",
      "change-subscription",
      "publish-website",
      "connect-providers",
      "send-communications",
      "create-follow-up",
      "propose-ai-action",
      "create-setup-proposal",
      "review-setup-proposal",
      "apply-setup-proposal",
      "authorize",
    ],
    deepLoader: "knowledge-launch-bounded-projection",
  },
  {
    id: "MATERIALS",
    purpose:
      "Explain recorded catalog, supplier mapping, purchase-list, PO, price freshness, pickup readiness, and material variance. Read/explain only. Not a second Materials engine and not live commerce.",
    enabled: true,
    requiredRoleCapability: CAPABILITIES.MANAGE_ESTIMATES,
    requiredProductCapability: "ESTIMATES_INVOICES",
    readScope: "materials-suppliers",
    approvalClass: COS_APPROVAL_CLASS,
    forbiddenBehavior: [
      "invoke-specialist",
      "purchase-materials",
      "create-purchase-order",
      "update-purchase-order",
      "add-purchase-list-item",
      "record-purchase",
      "link-expense",
      "refresh-supplier-prices",
      "save-supplier-preference",
      "send-supplier-request",
      "ensure-tables",
      "propose-ai-action",
      "create-action-item",
      "authorize",
    ],
    deepLoader: "materials-bounded-projection",
  },
  {
    id: "COMMUNICATIONS",
    purpose:
      "Explain recorded communication state, consent, delivery, and channel limitations. Read/explain only. Not a second communications engine and not an outbound sender.",
    enabled: true,
    requiredRoleCapability: CAPABILITIES.MANAGE_COMMUNICATIONS,
    requiredProductCapability: null,
    readScope: "communications",
    approvalClass: COS_APPROVAL_CLASS,
    forbiddenBehavior: [
      "invoke-specialist",
      "send-communications",
      "send-email",
      "send-sms",
      "make-phone-calls",
      "start-voice",
      "create-thread",
      "write-communication-records",
      "mutate-consent",
      "opt-in-out",
      "retry-delivery",
      "create-follow-up",
      "schedule-communications",
      "alter-customer-records",
      "propose-ai-action",
      "authorize",
    ],
    deepLoader: "communications-bounded-projection",
  },
  {
    id: "BUSINESS_PROTECTION",
    purpose: "Future Business Protection / Vault specialist. Disabled in PR1.",
    enabled: false,
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: null,
    readScope: "business-protection-vault",
    approvalClass: COS_APPROVAL_CLASS,
    forbiddenBehavior: ["deep-load-pr1", "invoke-specialist", "sign-agreements", "authorize"],
    deepLoader: "vault-deep",
  },
] as const;

export function getSpecialistEntry(id: SpecialistId) {
  const entry = SPECIALIST_REGISTRY.find((row) => row.id === id);
  if (!entry) throw new Error(`Unknown specialist ${id}`);
  return entry;
}

export function isSpecialistEnabled(id: SpecialistId) {
  return getSpecialistEntry(id).enabled;
}

export function enabledSpecialistIds() {
  return SPECIALIST_REGISTRY.filter((row) => row.enabled).map((row) => row.id);
}

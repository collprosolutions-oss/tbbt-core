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
    purpose: "Project Workforce recommendations and capacity facts already used by the BSOS workspace.",
    enabled: true,
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: null,
    readScope: "bsos-workforce-recommendations",
    approvalClass: COS_APPROVAL_CLASS,
    forbiddenBehavior: [
      "invoke-specialist",
      "assign-workers",
      "change-schedules",
      "mutate-domain",
      "authorize",
    ],
    deepLoader: null,
  },
  {
    id: "FINANCIAL",
    purpose: "Future Financial specialist. Disabled in PR1 — no deep financial load.",
    enabled: false,
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: "REPORTING_INSIGHTS",
    readScope: "financial-intelligence",
    approvalClass: COS_APPROVAL_CLASS,
    forbiddenBehavior: ["deep-load-pr1", "invoke-specialist", "write-payments", "authorize"],
    deepLoader: "financial-deep",
  },
  {
    id: "GROWTH",
    purpose: "Future Growth / Customer Success specialist. Disabled in PR1.",
    enabled: false,
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: null,
    readScope: "growth-department",
    approvalClass: COS_APPROVAL_CLASS,
    forbiddenBehavior: ["deep-load-pr1", "invoke-specialist", "create-growth-action", "authorize"],
    deepLoader: "growth-deep",
  },
  {
    id: "KNOWLEDGE_LAUNCH",
    purpose: "Future Knowledge / Launch specialist. Disabled in PR1.",
    enabled: false,
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: null,
    readScope: "knowledge-launch",
    approvalClass: COS_APPROVAL_CLASS,
    forbiddenBehavior: ["deep-load-pr1", "invoke-specialist", "approve-knowledge", "authorize"],
    deepLoader: "knowledge-launch-deep",
  },
  {
    id: "MATERIALS",
    purpose: "Future Materials specialist. Disabled in PR1.",
    enabled: false,
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: null,
    readScope: "materials-suppliers",
    approvalClass: COS_APPROVAL_CLASS,
    forbiddenBehavior: ["deep-load-pr1", "invoke-specialist", "purchase-materials", "authorize"],
    deepLoader: "materials-deep",
  },
  {
    id: "COMMUNICATIONS",
    purpose: "Future Communications specialist. Disabled in PR1.",
    enabled: false,
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: null,
    readScope: "communications",
    approvalClass: COS_APPROVAL_CLASS,
    forbiddenBehavior: ["deep-load-pr1", "invoke-specialist", "send-communications", "authorize"],
    deepLoader: "communications-deep",
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

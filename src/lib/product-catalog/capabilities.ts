/**
 * Product-entitlement capabilities. Separate from authorization.ts roles.
 *
 * LIVE means an implemented surface exists and may be gated.
 * PARTIAL means some related surface exists but the marketed product is not complete.
 * COMING_SOON / PLANNED must never be presented as a live software feature.
 */
import {
  CAPABILITY_IMPLEMENTATION_STATUSES,
  PRODUCT_CAPABILITIES,
  type CapabilityImplementationStatus,
  type ProductCapabilityCode,
} from "@/lib/product-catalog/codes";

export type ProductCapabilityDefinition = {
  code: ProductCapabilityCode;
  displayName: string;
  implementationStatus: CapabilityImplementationStatus;
  /** True when a server enforcement boundary is wired for this capability. */
  enforcementBoundary: boolean;
  enforcementNotes: string;
};

export const PRODUCT_CAPABILITY_DEFINITIONS: Record<
  ProductCapabilityCode,
  ProductCapabilityDefinition
> = {
  [PRODUCT_CAPABILITIES.WEBSITE_BUILDER]: {
    code: PRODUCT_CAPABILITIES.WEBSITE_BUILDER,
    displayName: "Website Builder",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.LIVE,
    enforcementBoundary: true,
    enforcementNotes: "Website draft writes and publish/rollback.",
  },
  [PRODUCT_CAPABILITIES.CRM]: {
    code: PRODUCT_CAPABILITIES.CRM,
    displayName: "CRM & Customer Management",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.LIVE,
    enforcementBoundary: true,
    enforcementNotes: "Customer create/update mutations.",
  },
  [PRODUCT_CAPABILITIES.CUSTOMER_REQUEST_INTAKE]: {
    code: PRODUCT_CAPABILITIES.CUSTOMER_REQUEST_INTAKE,
    displayName: "Customer request intake",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.LIVE,
    enforcementBoundary: false,
    enforcementNotes:
      "Public customer intake stays open. This capability describes the owner-side product, not the public form gate.",
  },
  [PRODUCT_CAPABILITIES.SCHEDULING]: {
    code: PRODUCT_CAPABILITIES.SCHEDULING,
    displayName: "Scheduling & Calendar",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.LIVE,
    enforcementBoundary: true,
    enforcementNotes: "Job scheduling and dispatch mutations.",
  },
  [PRODUCT_CAPABILITIES.ESTIMATES_INVOICES]: {
    code: PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
    displayName: "Estimates, Quotes & Invoices",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.LIVE,
    enforcementBoundary: true,
    enforcementNotes: "Estimate line ops and invoice mutations.",
  },
  [PRODUCT_CAPABILITIES.TIME_TRACKING]: {
    code: PRODUCT_CAPABILITIES.TIME_TRACKING,
    displayName: "Time Tracking",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.LIVE,
    enforcementBoundary: true,
    enforcementNotes: "Time card management mutations.",
  },
  [PRODUCT_CAPABILITIES.JOBS_TASKS]: {
    code: PRODUCT_CAPABILITIES.JOBS_TASKS,
    displayName: "Jobs & Task Management",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.LIVE,
    enforcementBoundary: true,
    enforcementNotes: "Job create/schedule/complete mutations.",
  },
  [PRODUCT_CAPABILITIES.TEAM_MANAGEMENT]: {
    code: PRODUCT_CAPABILITIES.TEAM_MANAGEMENT,
    displayName: "Team Management",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.LIVE,
    enforcementBoundary: true,
    enforcementNotes: "Team member create/invite boundary.",
  },
  [PRODUCT_CAPABILITIES.MARKETING_TOOLS]: {
    code: PRODUCT_CAPABILITIES.MARKETING_TOOLS,
    displayName: "Marketing Tools",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.LIVE,
    enforcementBoundary: true,
    enforcementNotes: "Marketing content workspace and Growth department mutations.",
  },
  [PRODUCT_CAPABILITIES.REPORTING_INSIGHTS]: {
    code: PRODUCT_CAPABILITIES.REPORTING_INSIGHTS,
    displayName: "Reporting & Business Insights",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.LIVE,
    enforcementBoundary: true,
    enforcementNotes: "Reports / BSOS / Growth analytics operating mutations.",
  },
  [PRODUCT_CAPABILITIES.CLIENT_PORTAL]: {
    code: PRODUCT_CAPABILITIES.CLIENT_PORTAL,
    displayName: "Client Portal",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.COMING_SOON,
    enforcementBoundary: false,
    enforcementNotes: "Existing customer estimate/work-order pages are not the marketed Client Portal.",
  },
  [PRODUCT_CAPABILITIES.MULTI_TRADE]: {
    code: PRODUCT_CAPABILITIES.MULTI_TRADE,
    displayName: "Additional trades",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.LIVE,
    enforcementBoundary: true,
    enforcementNotes: "BusinessTrade activation sits under the product limit, not a second trade engine.",
  },
  [PRODUCT_CAPABILITIES.MULTI_LOCATION]: {
    code: PRODUCT_CAPABILITIES.MULTI_LOCATION,
    displayName: "Multi-Location Support",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.PLANNED,
    enforcementBoundary: false,
    enforcementNotes: "No multi-location operations engine in this PR.",
  },
  [PRODUCT_CAPABILITIES.DOCUMENT_STORAGE]: {
    code: PRODUCT_CAPABILITIES.DOCUMENT_STORAGE,
    displayName: "Document Storage",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.PARTIAL,
    enforcementBoundary: false,
    enforcementNotes:
      "Job photos and website images already use BusinessStorageAccount. Marketed document vault is not this PR.",
  },
  [PRODUCT_CAPABILITIES.ADVANCED_REPORTING]: {
    code: PRODUCT_CAPABILITIES.ADVANCED_REPORTING,
    displayName: "Advanced Reporting",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.PLANNED,
    enforcementBoundary: false,
    enforcementNotes: "Financial Intelligence and advanced reports are later PRs.",
  },
  [PRODUCT_CAPABILITIES.EXPANDED_TEAM_ROLES]: {
    code: PRODUCT_CAPABILITIES.EXPANDED_TEAM_ROLES,
    displayName: "Expanded Team Roles & Permissions",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.PLANNED,
    enforcementBoundary: false,
    enforcementNotes: "Current roles remain OWNER/ADMIN/MEMBER. This capability does not grant roles.",
  },
  [PRODUCT_CAPABILITIES.CUSTOM_INTEGRATIONS]: {
    code: PRODUCT_CAPABILITIES.CUSTOM_INTEGRATIONS,
    displayName: "Custom Integrations",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.PLANNED,
    enforcementBoundary: false,
    enforcementNotes: "No integration marketplace in this PR.",
  },
  [PRODUCT_CAPABILITIES.ADVANCED_AUTOMATION]: {
    code: PRODUCT_CAPABILITIES.ADVANCED_AUTOMATION,
    displayName: "Advanced Automation",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.PARTIAL,
    enforcementBoundary: false,
    enforcementNotes: "Existing automation remains; marketed advanced automation is later work.",
  },
  [PRODUCT_CAPABILITIES.WHITE_LABEL]: {
    code: PRODUCT_CAPABILITIES.WHITE_LABEL,
    displayName: "White Label Options",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.PLANNED,
    enforcementBoundary: false,
    enforcementNotes: "White-label implementation is deferred.",
  },
  [PRODUCT_CAPABILITIES.SMS_MESSAGING]: {
    code: PRODUCT_CAPABILITIES.SMS_MESSAGING,
    displayName: "SMS Messaging",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.PARTIAL,
    enforcementBoundary: false,
    enforcementNotes:
      "See src/lib/communications/sms-policy.ts. Ordinary email never requires this add-on. Manual Communications Department SMS compose requires it. Existing operational SMS stays compatibility-ungated until #111. Not publicly purchasable or live.",
  },
  [PRODUCT_CAPABILITIES.AI_BUSINESS_COACH]: {
    code: PRODUCT_CAPABILITIES.AI_BUSINESS_COACH,
    displayName: "AI Business Coach",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.PLANNED,
    enforcementBoundary: false,
    enforcementNotes: "AI Chief of Staff / coach products are later PRs.",
  },
  [PRODUCT_CAPABILITIES.EXTRA_STORAGE]: {
    code: PRODUCT_CAPABILITIES.EXTRA_STORAGE,
    displayName: "Extra Storage",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.PLANNED,
    enforcementBoundary: true,
    enforcementNotes: "Add-on can increase STORAGE_BYTES later. No approved extra-storage quantity yet.",
  },
  [PRODUCT_CAPABILITIES.BUSINESS_EMAIL]: {
    code: PRODUCT_CAPABILITIES.BUSINESS_EMAIL,
    displayName: "Business Email",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.PLANNED,
    enforcementBoundary: false,
    enforcementNotes: "Live mailbox provisioning is deferred.",
  },
  [PRODUCT_CAPABILITIES.MOBILE_ACCESS]: {
    code: PRODUCT_CAPABILITIES.MOBILE_ACCESS,
    displayName: "Mobile Access",
    implementationStatus: CAPABILITY_IMPLEMENTATION_STATUSES.PLANNED,
    enforcementBoundary: false,
    enforcementNotes: "Native mobile apps are not built. Do not present as a live software feature.",
  },
};

export function getProductCapabilityDefinition(code: ProductCapabilityCode) {
  return PRODUCT_CAPABILITY_DEFINITIONS[code];
}

export function isLiveSoftwareCapability(code: ProductCapabilityCode) {
  const status = PRODUCT_CAPABILITY_DEFINITIONS[code].implementationStatus;
  return (
    status === CAPABILITY_IMPLEMENTATION_STATUSES.LIVE ||
    status === CAPABILITY_IMPLEMENTATION_STATUSES.PARTIAL
  );
}

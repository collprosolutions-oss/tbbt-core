/**
 * Settings Core domain -- owner-controlled configuration for one business.
 *
 * This is NOT a generic preferences page. Settings control how the
 * business operates while preserving tenant isolation, historical record
 * integrity, owner authority, and provider-neutral integrations.
 *
 * Settings changes affect FUTURE behavior unless a specific record is
 * designed to recompute. Historical estimates, approved versions, jobs,
 * invoices, payroll snapshots, and time-card approvals are never rewritten
 * merely because a setting changed today.
 *
 * No AI Coach, no provider adapters, no secret values.
 */

export const SETTINGS_SECTIONS = [
  "overview",
  "profile",
  "website-photos",
  "team",
  "pricing",
  "scheduling",
  "estimates-payments",
  "payroll",
  "banking",
  "vendors",
  "communications",
  "marketing",
  "notifications",
  "documents",
  "integrations",
  "security",
  "data-export",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
  overview: "Overview",
  profile: "Business Profile",
  "website-photos": "Website Photos",
  team: "Team & Permissions",
  pricing: "Services & Pricing Rules",
  scheduling: "Scheduling",
  "estimates-payments": "Estimates & Payments",
  payroll: "Payroll",
  banking: "Banking & Financial Connections",
  vendors: "Vendors & Purchasing",
  communications: "Customer Communications",
  marketing: "Reviews / Marketing Connections",
  notifications: "Notifications",
  documents: "Documents / Policies",
  integrations: "Integrations",
  security: "Security & Privacy",
  "data-export": "Data / Export",
};

export const DEFAULT_SETTINGS_SECTION: SettingsSection = "overview";

export function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export function parseSettingsSection(value: string | undefined): SettingsSection {
  if (value && isSettingsSection(value)) {
    return value;
  }
  return DEFAULT_SETTINGS_SECTION;
}

export const SETTINGS_READINESS_STATUSES = [
  "configured",
  "needs_setup",
  "not_connected",
  "optional",
] as const;
export type SettingsReadinessStatus = (typeof SETTINGS_READINESS_STATUSES)[number];

export const SETTINGS_READINESS_LABELS: Record<SettingsReadinessStatus, string> = {
  configured: "Configured",
  needs_setup: "Needs Setup",
  not_connected: "Not Connected",
  optional: "Optional",
};

export type SettingsReadinessItem = {
  id: string;
  label: string;
  section: SettingsSection;
  status: SettingsReadinessStatus;
  detail: string;
  required: boolean;
};

export type SettingsReadiness = {
  items: SettingsReadinessItem[];
  requiredTotal: number;
  requiredReady: number;
  readyPercent: number;
};

export const LABOR_MINIMUM_FUTURE_RULE_MESSAGE =
  "This changes the minimum applied to future estimates. Existing estimates and approved work are not changed.";

export const BUSINESS_NAME_CHANGE_MESSAGE =
  "This updates the business name shown across TBBT. Historical records keep the values they already stored.";

export const SETTINGS_SECRET_REDACTED = "[redacted]";

const SECRET_KEY_PATTERN =
  /(password|token|secret|api[_-]?key|credential|bank[_-]?account|routing|ssn)/i;

export function isSecretSettingKey(settingKey: string): boolean {
  return SECRET_KEY_PATTERN.test(settingKey);
}

/**
 * Safe serialized form for the settings audit log. Secret-looking keys
 * are stored as [redacted] even if a caller accidentally passed a value.
 */
export function serializeAuditValue(settingKey: string, value: unknown): string {
  if (isSecretSettingKey(settingKey)) {
    return SETTINGS_SECRET_REDACTED;
  }
  if (value === undefined) {
    return "null";
  }
  return JSON.stringify(value);
}

export function settingsAiAssistAvailable(): boolean {
  return false;
}

export const EMAIL_DELIVERY_UNCONFIGURED_MESSAGE =
  "Email delivery is not configured. TBBT does not send customer SMS or email from Settings.";

export const SMS_DELIVERY_UNAVAILABLE_MESSAGE =
  "SMS delivery is not connected. TBBT does not send customer text messages.";

export const PAYMENT_PROVIDER_DISCONNECTED_MESSAGE =
  "No payment provider is connected. TBBT records cash, check, Zelle / bank transfer, card, and other payments manually.";

export const PAYROLL_PROVIDER_DISCONNECTED_MESSAGE =
  "No payroll provider is connected. TBBT prepares, reviews, and records payroll — it does not move money.";

export const BANK_DISCONNECTED_MESSAGE =
  "Bank account is not connected. TBBT does not invent a bank balance.";

export const PROJECTED_BALANCE_UNAVAILABLE_MESSAGE =
  "Projected operating balance is unavailable without a last verified bank balance.";

export const MARKETING_CONNECTIONS_DISCONNECTED_MESSAGE =
  "No Google Business Profile, Facebook, or Instagram account is connected. External publishing is not available.";

export const REVIEW_PLATFORMS_DISCONNECTED_MESSAGE =
  "No Google or Facebook review platform is connected. External review counts, ratings, and publishing are not available.";

export const EMERGENCY_SECURITY_LOCK_DEFERRED_MESSAGE =
  "Emergency Security Lock is not implemented. Future capability: sign out other sessions, pause publishing, freeze delegated admin, and require re-auth to resume — without deletion.";

export const DOCUMENT_STORAGE_DEFERRED_MESSAGE =
  "Business document storage is not implemented. Knowledge Hub holds durable operational knowledge separately from Settings.";

export const SCHEDULING_DEFAULTS_DEFERRED_MESSAGE =
  "Advanced scheduling defaults (default job duration, buffer, working hours) are not persisted yet. Existing scheduled jobs keep their own date and duration.";

export const ACCOUNT_DELETION_UNAVAILABLE_MESSAGE =
  "Account deletion is not available. Historical business records remain preserved.";

export const FULL_EXPORT_PLANNED_MESSAGE =
  "Full ZIP export, estimate/job/invoice PDF packs, payroll CSV, and original photo export are planned. Only working downloads are offered below.";

export type IntegrationConnectionStatus = "connected" | "not_connected" | "needs_attention";

export const INTEGRATION_STATUS_LABELS: Record<IntegrationConnectionStatus, string> = {
  connected: "Connected",
  not_connected: "Not Connected",
  needs_attention: "Needs Attention",
};

export type IntegrationCard = {
  id: string;
  category: string;
  label: string;
  status: IntegrationConnectionStatus;
  detail: string;
};

export type SettingsPreferenceFlags = {
  estimateCommunicationEnabled: boolean;
  scheduleNotificationEnabled: boolean;
  invoiceCommunicationEnabled: boolean;
  reviewRequestPreferenceEnabled: boolean;
  marketingCommunicationEnabled: boolean;
  notifyEstimateEvents: boolean;
  notifyScheduleEvents: boolean;
  notifyInvoiceEvents: boolean;
  notifyPayrollEvents: boolean;
  notifyTeamEvents: boolean;
};

export const DEFAULT_SETTINGS_PREFERENCES: SettingsPreferenceFlags = {
  estimateCommunicationEnabled: true,
  scheduleNotificationEnabled: true,
  invoiceCommunicationEnabled: true,
  reviewRequestPreferenceEnabled: false,
  marketingCommunicationEnabled: false,
  notifyEstimateEvents: true,
  notifyScheduleEvents: true,
  notifyInvoiceEvents: true,
  notifyPayrollEvents: true,
  notifyTeamEvents: true,
};

export type SettingsReadinessInput = {
  businessName: string;
  laborMinimumEnabled: boolean;
  laborMinimumAmount: string | null;
  activeMemberCount: number;
  catalogItemCount: number;
  emailDeliveryConfigured: boolean;
  paymentProviderConnected: boolean;
  payrollProviderConnected: boolean;
  bankConnected: boolean;
  marketingConnected: boolean;
  reviewPlatformConnected: boolean;
};

/**
 * Deterministic readiness for Settings Overview and the future BSOS Coach
 * foundation. Every status is produced from an explicit check — never an
 * invented score, bank balance, or provider health signal.
 */
export function buildSettingsReadiness(input: SettingsReadinessInput): SettingsReadiness {
  const items: SettingsReadinessItem[] = [
    {
      id: "profile",
      label: "Business Profile",
      section: "profile",
      status: input.businessName.trim() ? "configured" : "needs_setup",
      detail: input.businessName.trim()
        ? "Business name is on file."
        : "Add the business name used across TBBT.",
      required: true,
    },
    {
      id: "team",
      label: "Team",
      section: "team",
      status: input.activeMemberCount > 0 ? "configured" : "needs_setup",
      detail:
        input.activeMemberCount > 0
          ? `${input.activeMemberCount} active membership${input.activeMemberCount === 1 ? "" : "s"}.`
          : "No active memberships.",
      required: true,
    },
    {
      id: "pricing",
      label: "Pricing Rules",
      section: "pricing",
      status: input.laborMinimumEnabled && input.laborMinimumAmount
        ? "configured"
        : "optional",
      detail: input.laborMinimumEnabled && input.laborMinimumAmount
        ? `Labor minimum is enabled at ${input.laborMinimumAmount}.`
        : input.catalogItemCount > 0
          ? `${input.catalogItemCount} catalog service${input.catalogItemCount === 1 ? "" : "s"}. Labor minimum is optional.`
          : "Labor minimum is optional. Service catalog pricing is managed on Services.",
      required: false,
    },
    {
      id: "scheduling",
      label: "Scheduling",
      section: "scheduling",
      status: "optional",
      detail: SCHEDULING_DEFAULTS_DEFERRED_MESSAGE,
      required: false,
    },
    {
      id: "payments",
      label: "Payments",
      section: "estimates-payments",
      status: input.paymentProviderConnected ? "configured" : "not_connected",
      detail: input.paymentProviderConnected
        ? "A payment provider is connected."
        : PAYMENT_PROVIDER_DISCONNECTED_MESSAGE,
      required: false,
    },
    {
      id: "payroll",
      label: "Payroll",
      section: "payroll",
      status: input.payrollProviderConnected ? "configured" : "not_connected",
      detail: input.payrollProviderConnected
        ? "A payroll provider is connected."
        : PAYROLL_PROVIDER_DISCONNECTED_MESSAGE,
      required: false,
    },
    {
      id: "banking",
      label: "Banking",
      section: "banking",
      status: input.bankConnected ? "configured" : "not_connected",
      detail: input.bankConnected
        ? "A verified bank connection is on file."
        : BANK_DISCONNECTED_MESSAGE,
      required: false,
    },
    {
      id: "communications",
      label: "Communications",
      section: "communications",
      status: input.emailDeliveryConfigured ? "configured" : "needs_setup",
      detail: input.emailDeliveryConfigured
        ? "Platform email delivery is configured. Customer SMS is not connected."
        : EMAIL_DELIVERY_UNCONFIGURED_MESSAGE,
      required: false,
    },
    {
      id: "marketing",
      label: "Marketing Connections",
      section: "marketing",
      status: input.marketingConnected || input.reviewPlatformConnected
        ? "configured"
        : "not_connected",
      detail: input.marketingConnected || input.reviewPlatformConnected
        ? "An external marketing or review connection is on file."
        : MARKETING_CONNECTIONS_DISCONNECTED_MESSAGE,
      required: false,
    },
    {
      id: "security",
      label: "Security",
      section: "security",
      status: "configured",
      detail: "Tenant isolation and OWNER / ADMIN / MEMBER roles are enforced.",
      required: true,
    },
    {
      id: "data-export",
      label: "Data / Export",
      section: "data-export",
      status: "optional",
      detail: "Customer CSV export is available. Full ZIP and PDF packs are planned.",
      required: false,
    },
  ];

  const required = items.filter((item) => item.required);
  const requiredReady = required.filter((item) => item.status === "configured").length;
  const requiredTotal = required.length;
  const readyPercent = requiredTotal === 0
    ? 0
    : Math.round((requiredReady / requiredTotal) * 100);

  return { items, requiredTotal, requiredReady, readyPercent };
}

export function buildIntegrationCards(input: {
  emailDeliveryConfigured: boolean;
  paymentProviderConnected: boolean;
  payrollProviderConnected: boolean;
  bankConnected: boolean;
  accountingConnected: boolean;
  marketingConnected: boolean;
  storageConfigured: boolean;
}): IntegrationCard[] {
  return [
    {
      id: "payments",
      category: "Payments",
      label: "Payment provider",
      status: input.paymentProviderConnected ? "connected" : "not_connected",
      detail: input.paymentProviderConnected
        ? "A payment provider is connected."
        : PAYMENT_PROVIDER_DISCONNECTED_MESSAGE,
    },
    {
      id: "banking",
      category: "Banking",
      label: "Bank connection",
      status: input.bankConnected ? "connected" : "not_connected",
      detail: input.bankConnected
        ? "A verified bank connection is on file."
        : BANK_DISCONNECTED_MESSAGE,
    },
    {
      id: "payroll",
      category: "Payroll",
      label: "Payroll provider",
      status: input.payrollProviderConnected ? "connected" : "not_connected",
      detail: input.payrollProviderConnected
        ? "A payroll provider is connected."
        : PAYROLL_PROVIDER_DISCONNECTED_MESSAGE,
    },
    {
      id: "accounting",
      category: "Accounting",
      label: "Accounting connection",
      status: input.accountingConnected ? "connected" : "not_connected",
      detail: input.accountingConnected
        ? "An accounting connection is on file."
        : "No accounting provider is connected.",
    },
    {
      id: "email",
      category: "Email / Communications",
      label: "Email delivery",
      status: input.emailDeliveryConfigured ? "connected" : "not_connected",
      detail: input.emailDeliveryConfigured
        ? "Platform email delivery is configured. API keys are not shown."
        : EMAIL_DELIVERY_UNCONFIGURED_MESSAGE,
    },
    {
      id: "marketing",
      category: "Marketing / Social",
      label: "Marketing / review platforms",
      status: input.marketingConnected ? "connected" : "not_connected",
      detail: input.marketingConnected
        ? "An external marketing or review connection is on file."
        : MARKETING_CONNECTIONS_DISCONNECTED_MESSAGE,
    },
    {
      id: "storage",
      category: "Storage",
      label: "File storage",
      status: input.storageConfigured ? "connected" : "not_connected",
      detail: input.storageConfigured
        ? "File storage is configured for job photos and receipts. Credentials are not shown."
        : "File storage is not configured.",
    },
  ];
}

export function isEmailDeliveryConfigured(): boolean {
  return !("error" in getMailConfigSafe());
}

function getMailConfigSafe(): { configured: true } | { error: string } {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    return { error: "Email delivery is not configured" };
  }
  return { configured: true };
}

export function isBlobStorageConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

/**
 * First-party integration registry.
 *
 * Only integrations the product can actually use are registered.
 * Placeholder / planned providers stay in UNSUPPORTED_INTEGRATIONS so
 * the owner page cannot advertise them.
 *
 * Future add-ons register with `composeIntegrationRegistry` — the page
 * iterates the projected center and does not hardcode provider keys.
 */
import { GO_LIVE_CARD_REQUIREMENTS, type GoLiveCapabilityId } from "@/lib/go-live";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog/codes";
import type { IntegrationDefinition, UnsupportedIntegration } from "@/lib/integrations/types";

export const INTEGRATION_REGISTRY: readonly IntegrationDefinition[] = [
  {
    key: "stripe_saas",
    displayName: "Stripe SaaS subscription",
    category: "Payments",
    requirement: GO_LIVE_CARD_REQUIREMENTS.stripe_saas,
    goLiveCapabilityId: "stripe_saas",
    description:
      "TBBT software access billing. This is not customer job payments and is not Stripe Connect.",
    settingsHref: "/settings?section=tbbt-billing",
  },
  {
    key: "stripe_connect",
    displayName: "Stripe Connect customer payments",
    category: "Payments",
    requirement: GO_LIVE_CARD_REQUIREMENTS.stripe_connect,
    goLiveCapabilityId: "stripe_connect",
    description:
      "Online card checkout for customer deposits and invoices. Cash, check, and Zelle Mark Paid still work without Connect.",
    settingsHref: "/settings?section=estimates-payments",
  },
  {
    key: "resend",
    displayName: "Resend email",
    category: "Communications",
    requirement: GO_LIVE_CARD_REQUIREMENTS.resend,
    goLiveCapabilityId: "resend",
    description:
      "Transactional email delivery. An API key alone is not enough — Go-live requires a complete mail configuration.",
    settingsHref: "/settings?section=communications",
  },
  {
    key: "r2",
    displayName: "R2 / storage",
    category: "Storage",
    requirement: GO_LIVE_CARD_REQUIREMENTS.r2,
    goLiveCapabilityId: "r2",
    description:
      "Platform object storage for intake, job, and website photo uploads. Missing storage does not delete recorded jobs.",
    settingsHref: "/settings?section=website-photos",
  },
  {
    key: "twilio_sms",
    displayName: "Twilio SMS",
    category: "Communications",
    requirement: GO_LIVE_CARD_REQUIREMENTS.twilio_sms,
    goLiveCapabilityId: "twilio_sms",
    productCapability: PRODUCT_CAPABILITIES.SMS_MESSAGING,
    description:
      "Optional outbound SMS. Platform credentials never mean every SMS feature is live. A dedicated business number is additional proof.",
    settingsHref: "/settings?section=communications",
  },
  {
    key: "custom_domain",
    displayName: "Custom / public domain",
    category: "Website/Domain",
    requirement: GO_LIVE_CARD_REQUIREMENTS.custom_domain,
    goLiveCapabilityId: "custom_domain",
    productCapability: PRODUCT_CAPABILITIES.WEBSITE_BUILDER,
    description:
      "Optional custom hostname for the public site. The /hire site for this business slug still works without a custom domain.",
    settingsHref: "/settings?section=website-publish",
  },
  {
    key: "ai_provider",
    displayName: "AI provider",
    category: "AI",
    requirement: GO_LIVE_CARD_REQUIREMENTS.ai_provider,
    goLiveCapabilityId: "ai_provider",
    productCapability: PRODUCT_CAPABILITIES.AI_BUSINESS_COACH,
    description:
      "Optional provider synthesis for entitled Coach asks. Recorded facts stay the source of truth. A key presence is not a live product claim.",
    settingsHref: "/settings?section=overview",
  },
  {
    key: "esign",
    displayName: "Dropbox Sign e-sign",
    category: "Documents/e-sign",
    requirement: GO_LIVE_CARD_REQUIREMENTS.esign,
    goLiveCapabilityId: "esign",
    description:
      "Connected e-sign adapter for OWNER Send of a locked agreement version. Webhooks bind the signed file to that exact business, agreement, and version. Manual upload remains available.",
    settingsHref: "/business-protection?area=agreements",
  },
  {
    key: "gusto_payroll",
    displayName: "Gusto payroll facts",
    category: "Payroll",
    requirement: GO_LIVE_CARD_REQUIREMENTS.gusto_payroll,
    goLiveCapabilityId: "gusto_payroll",
    description:
      "Owner-only import of processed Gusto payroll facts for review. Not a payroll run, not a bank withdrawal, and not net pay. A connection is recorded only after token exchange and token info. Missing partner credentials stay unavailable.",
    settingsHref: "/payroll#gusto-payroll",
  },
];

/**
 * Integrations discovered in the codebase that must not appear on the
 * owner center because TBBT cannot actually use them today.
 */
export const UNSUPPORTED_INTEGRATIONS: readonly UnsupportedIntegration[] = [
  {
    key: "google_calendar",
    category: "Calendar",
    reason: "No Google Calendar OAuth, sync, or provider adapter exists. Scheduling is in-app only.",
  },
  {
    key: "finance_bank",
    category: "Financial",
    goLiveCapabilityId: "finance_bank",
    reason: "Finance/bank provider is a disconnected placeholder. Env strings do not invent a connection.",
  },
  {
    key: "accounting_connection",
    category: "Accounting",
    goLiveCapabilityId: "finance_bank",
    reason:
      "No live QuickBooks or Xero connection. Recorded invoice/payment/expense CSV export is a data tool, not a provider integration.",
  },
  {
    key: "supplier_commerce",
    category: "Materials/Suppliers",
    goLiveCapabilityId: "supplier_commerce",
    reason: "Supplier commerce adapter is disconnected. TBBT does not log into retailer accounts or place orders.",
  },
  {
    key: "adobe_sign",
    category: "Documents/e-sign",
    reason: "Adobe Sign is not a connected adapter. Dropbox Sign is the one e-sign provider TBBT can use.",
  },
  {
    key: "voice_receptionist",
    category: "Communications",
    goLiveCapabilityId: "voice_receptionist",
    reason: "Voice receptionist is not connected. Go-live classifier is always DISCONNECTED.",
  },
  {
    key: "social_publishing",
    category: "Communications",
    goLiveCapabilityId: "social_publishing",
    reason:
      "Facebook Page, Instagram, and Google Business Profile consent is an OWNER action on Marketing. This center does not start it. Publishing still requires OWNER-approved content and an explicit OWNER publish click. Instagram uses only an approved public marketing image and never sends private job or customer photos. Google Business Profile publishing is not yet available.",
  },
];

export function listSupportedIntegrationKeys() {
  return INTEGRATION_REGISTRY.map((item) => item.key);
}

export function getIntegrationDefinition(key: string) {
  return INTEGRATION_REGISTRY.find((item) => item.key === key) ?? null;
}

export function composeIntegrationRegistry(
  extras: readonly IntegrationDefinition[] = [],
  base: readonly IntegrationDefinition[] = INTEGRATION_REGISTRY,
): IntegrationDefinition[] {
  const seen = new Set<string>();
  const next: IntegrationDefinition[] = [];
  for (const item of [...base, ...extras]) {
    if (seen.has(item.key)) {
      throw new Error(`Duplicate integration key ${item.key}.`);
    }
    seen.add(item.key);
    next.push(item);
  }
  return next;
}

export function assertRegistryUsesGoLiveCapabilities(
  registry: readonly IntegrationDefinition[] = INTEGRATION_REGISTRY,
) {
  for (const item of registry) {
    if (item.requirement !== GO_LIVE_CARD_REQUIREMENTS[item.goLiveCapabilityId as GoLiveCapabilityId]) {
      throw new Error(
        `Integration ${item.key} requirement drifted from Go-live ${item.goLiveCapabilityId}.`,
      );
    }
  }
}

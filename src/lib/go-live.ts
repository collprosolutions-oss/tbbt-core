/**
 * Go-live / Integration Health Center.
 *
 * Read-only production readiness for one business. Status is classified
 * from existing configuration only. This module does not connect
 * providers, mutate connection state, or expose secrets.
 *
 * There is no single "100% ready" boolean or launch percentage.
 * Cards use REQUIRED / CONDITIONAL / OPTIONAL. Mixed groups stay mixed.
 */
import type { SaasEntitlementState } from "@/lib/saas-billing/entitlement";
import type { PaymentConnectionStatus } from "@/lib/payments/types";
import { getSupplierCommerceAdapter } from "@/lib/materials/adapter";
import { getFinanceConnectionProvider } from "@/lib/finance-connections";
import { resolveEsignProviderStatus } from "@/lib/business-protection-esign";
import { SMS_COMMERCIAL_BOUNDARY } from "@/lib/communications/sms-policy";
import { VOICE_NOT_CONNECTED_REASON } from "@/lib/communications/types";

export const GO_LIVE_PATH = "/settings?section=go-live";

export const GO_LIVE_STATUSES = [
  "LIVE",
  "READY",
  "PARTIAL",
  "NOT_CONFIGURED",
  "DISCONNECTED",
  "PLANNED",
  "UNAVAILABLE",
] as const;
export type GoLiveStatus = (typeof GO_LIVE_STATUSES)[number];

export const GO_LIVE_GROUPS = [
  "CORE_OPERATING",
  "PAYMENTS",
  "COMMUNICATIONS",
  "STORAGE",
  "AI",
  "OPTIONAL_PLANNED",
] as const;
export type GoLiveGroup = (typeof GO_LIVE_GROUPS)[number];

export const GO_LIVE_CAPABILITIES = [
  "stripe_saas",
  "stripe_connect",
  "resend",
  "r2",
  "twilio_sms",
  "ai_provider",
  "custom_domain",
  "finance_bank",
  "supplier_commerce",
  "esign",
  "voice_receptionist",
  "social_publishing",
] as const;
export type GoLiveCapabilityId = (typeof GO_LIVE_CAPABILITIES)[number];

export const GO_LIVE_REQUIREMENTS = ["REQUIRED", "CONDITIONAL", "OPTIONAL"] as const;
export type GoLiveRequirement = (typeof GO_LIVE_REQUIREMENTS)[number];
export type GoLiveGroupRequirement = GoLiveRequirement | "MIXED";

export const GO_LIVE_CARD_REQUIREMENTS: Record<GoLiveCapabilityId, GoLiveRequirement> = {
  stripe_saas: "REQUIRED",
  stripe_connect: "CONDITIONAL",
  resend: "REQUIRED",
  r2: "REQUIRED",
  twilio_sms: "OPTIONAL",
  ai_provider: "OPTIONAL",
  custom_domain: "OPTIONAL",
  finance_bank: "OPTIONAL",
  supplier_commerce: "OPTIONAL",
  esign: "OPTIONAL",
  voice_receptionist: "OPTIONAL",
  social_publishing: "OPTIONAL",
};

export const GO_LIVE_REQUIREMENT_LABELS: Record<GoLiveRequirement, string> = {
  REQUIRED: "Required",
  CONDITIONAL: "Conditional",
  OPTIONAL: "Optional",
};

export const GO_LIVE_GROUP_REQUIREMENT_LABELS: Record<GoLiveGroupRequirement, string> = {
  REQUIRED: "Required",
  CONDITIONAL: "Conditional",
  OPTIONAL: "Optional",
  MIXED: "Mixed",
};

export const GO_LIVE_GROUP_LABELS: Record<GoLiveGroup, string> = {
  CORE_OPERATING: "Core operating",
  PAYMENTS: "Payments",
  COMMUNICATIONS: "Communications",
  STORAGE: "Storage",
  AI: "AI",
  OPTIONAL_PLANNED: "Optional / planned",
};

export const GO_LIVE_GROUP_SUMMARIES: Record<GoLiveGroup, string> = {
  CORE_OPERATING:
    "Required. Software access for the business to keep using TBBT in production. This is not customer job payments.",
  PAYMENTS:
    "Conditional. Required for online card payments; manual Mark Paid remains available.",
  COMMUNICATIONS: "Mixed. Email is required; SMS and voice are optional.",
  STORAGE:
    "Required. Needed for intake, job, and website photo upload. Missing storage does not delete recorded jobs.",
  AI: "Optional. Deterministic Coach facts stay available without a provider.",
  OPTIONAL_PLANNED:
    "Optional. Disconnected or planned capabilities. Absence is not a production outage.",
};

export const GO_LIVE_STATUS_LABELS: Record<GoLiveStatus, string> = {
  LIVE: "Live",
  READY: "Ready",
  PARTIAL: "Partial",
  NOT_CONFIGURED: "Not configured",
  DISCONNECTED: "Disconnected",
  PLANNED: "Planned",
  UNAVAILABLE: "Unavailable",
};

export const GO_LIVE_NO_SCORE_DISCLAIMER =
  "This is a status board, not a launch score. Required, conditional, and optional items are listed separately. Disconnected systems are not broken.";

export const GO_LIVE_REQUIRED_SUMMARY =
  "Required for core production: SaaS access, transactional email, and photo storage.";

export const GO_LIVE_CONDITIONAL_SUMMARY =
  "Conditional: Stripe Connect for online card checkout.";

export const GO_LIVE_OPTIONAL_SUMMARY =
  "Optional/planned: SMS, AI, domain, bank, suppliers, e-sign, voice, social.";

export const GO_LIVE_READ_ONLY_MESSAGE =
  "This page reports current configuration only. It does not connect providers, start onboarding, or change billing.";

export type GoLiveCard = {
  id: GoLiveCapabilityId;
  label: string;
  group: GoLiveGroup;
  status: GoLiveStatus;
  requirement: GoLiveRequirement;
  currentState: string;
  whatWorks: string;
  whatDoesNot: string;
  ownerNextAction: string;
  settingsHref: string;
};

export type GoLiveLaunchGroup = {
  id: GoLiveGroup;
  label: string;
  summary: string;
  requirement: GoLiveGroupRequirement;
  requirementLabel: string;
  cards: GoLiveCard[];
  liveCount: number;
  readyCount: number;
  remainingCount: number;
  totalCount: number;
};

export type GoLiveCenter = {
  cards: GoLiveCard[];
  groups: GoLiveLaunchGroup[];
  requiredCards: GoLiveCard[];
  conditionalCards: GoLiveCard[];
  optionalCards: GoLiveCard[];
  requiredLiveCount: number;
  requiredReadyCount: number;
  requiredRemainingCount: number;
  disclaimer: string;
  readOnly: true;
};

export type GoLiveDomainInput = {
  verifiedHostname: string | null;
  unverifiedHostname: string | null;
  failedHostname: string | null;
};

export type GoLiveInput = {
  saas: {
    configured: boolean;
    checkoutPossible: boolean;
    entitlementState: SaasEntitlementState;
    canOperate: boolean;
    statusLabel: string;
  };
  connect: {
    platformConfigured: boolean;
    appUrlConfigured: boolean;
    paymentReady: boolean;
    status: PaymentConnectionStatus;
    onlineCheckoutPossible: boolean;
  };
  emailConfigured: boolean;
  r2Configured: boolean;
  twilio: {
    platformConfigured: boolean;
    dedicatedNumberAssigned: boolean;
  };
  aiConnected: boolean;
  domain: GoLiveDomainInput;
};

const SECRET_KEY_PATTERN =
  /(password|token|secret|api[_-]?key|credential|stripeCustomerId|stripeSubscriptionId|stripePriceId|stripeAccountId|accountSid|authToken|accessKey|secretAccessKey)/i;

const SECRET_VALUE_PATTERN =
  /(sk_live_|sk_test_|whsec_|rk_live_|rk_test_|acct_[A-Za-z0-9]{6,}|re_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16})/;

export function isGoLiveStatus(value: string): value is GoLiveStatus {
  return (GO_LIVE_STATUSES as readonly string[]).includes(value);
}

export function isGoLiveGroup(value: string): value is GoLiveGroup {
  return (GO_LIVE_GROUPS as readonly string[]).includes(value);
}

export function isGoLiveRequirement(value: string): value is GoLiveRequirement {
  return (GO_LIVE_REQUIREMENTS as readonly string[]).includes(value);
}

export function goLiveGroupRequirement(cards: readonly GoLiveCard[]): GoLiveGroupRequirement {
  const unique = [...new Set(cards.map((card) => card.requirement))];
  if (unique.length === 1) return unique[0];
  return "MIXED";
}

export function classifyStripeSaas(input: GoLiveInput["saas"]): GoLiveStatus {
  if (
    input.entitlementState === "subscribed_active" ||
    input.entitlementState === "trial_active" ||
    input.entitlementState === "legacy_exempt"
  ) {
    return "LIVE";
  }
  if (input.entitlementState === "payment_problem") {
    return "PARTIAL";
  }
  if (!input.configured) {
    return "NOT_CONFIGURED";
  }
  if (input.checkoutPossible && input.entitlementState === "subscription_required") {
    return "READY";
  }
  return "PARTIAL";
}

export function classifyStripeConnect(input: GoLiveInput["connect"]): GoLiveStatus {
  if (input.onlineCheckoutPossible && input.paymentReady) {
    return "LIVE";
  }
  if (!input.platformConfigured) {
    return "NOT_CONFIGURED";
  }
  if (input.status === "setup_required" || (input.paymentReady && !input.appUrlConfigured)) {
    return "PARTIAL";
  }
  if (input.paymentReady && input.appUrlConfigured) {
    return "READY";
  }
  return "DISCONNECTED";
}

export function classifyResend(emailConfigured: boolean): GoLiveStatus {
  return emailConfigured ? "LIVE" : "UNAVAILABLE";
}

export function classifyR2(r2Configured: boolean): GoLiveStatus {
  return r2Configured ? "LIVE" : "NOT_CONFIGURED";
}

export function classifyTwilioSms(input: GoLiveInput["twilio"]): GoLiveStatus {
  if (!input.platformConfigured) {
    return "UNAVAILABLE";
  }
  if (!input.dedicatedNumberAssigned) {
    return "PARTIAL";
  }
  return "READY";
}

/** Env credentials never mean every SMS product is live. */
export function twilioImpliesAllFeaturesLive() {
  return SMS_COMMERCIAL_BOUNDARY.liveProduct;
}

export function classifyAiProvider(aiConnected: boolean): GoLiveStatus {
  return aiConnected ? "READY" : "DISCONNECTED";
}

export function classifyCustomDomain(input: GoLiveDomainInput): GoLiveStatus {
  if (input.verifiedHostname) return "LIVE";
  if (input.unverifiedHostname || input.failedHostname) return "PARTIAL";
  return "NOT_CONFIGURED";
}

export function classifyFinanceBank(): GoLiveStatus {
  const status = getFinanceConnectionProvider().status();
  return status.banking.connected || status.accounting.connected
    ? "READY"
    : "DISCONNECTED";
}

export function classifySupplierCommerce(): GoLiveStatus {
  return getSupplierCommerceAdapter().connectionState === "CONNECTED"
    ? "READY"
    : "DISCONNECTED";
}

export function classifyEsign(): GoLiveStatus {
  return resolveEsignProviderStatus() === "PROVIDER_READY" ? "READY" : "DISCONNECTED";
}

export function classifyVoiceReceptionist(): GoLiveStatus {
  return "DISCONNECTED";
}

export function classifySocialPublishing(): GoLiveStatus {
  return "DISCONNECTED";
}

function stripeSaasCard(input: GoLiveInput["saas"]): GoLiveCard {
  const status = classifyStripeSaas(input);
  if (status === "LIVE") {
    return {
      id: "stripe_saas",
      label: "Stripe SaaS subscription",
      group: "CORE_OPERATING",
      status,
      requirement: GO_LIVE_CARD_REQUIREMENTS.stripe_saas,
      currentState: `${input.statusLabel}. The business can use TBBT software access.`,
      whatWorks: "Owner/admin operating pages stay available under the current entitlement.",
      whatDoesNot: "This is not Stripe Connect. Customers do not pay job invoices here.",
      ownerNextAction: "No billing connection is needed from this page. Review TBBT Billing only if the plan should change.",
      settingsHref: "/settings?section=tbbt-billing",
    };
  }
  if (status === "READY") {
    return {
      id: "stripe_saas",
      label: "Stripe SaaS subscription",
      group: "CORE_OPERATING",
      status,
      requirement: GO_LIVE_CARD_REQUIREMENTS.stripe_saas,
      currentState: "Checkout is ready. The business still needs an active subscription or trial.",
      whatWorks: "TBBT Billing can start Founder Checkout when the owner chooses.",
      whatDoesNot: "Operating access stays blocked until a subscription or trial is active.",
      ownerNextAction: "Open TBBT Billing and start checkout when you are ready. This page does not start checkout.",
      settingsHref: "/settings?section=tbbt-billing",
    };
  }
  if (status === "NOT_CONFIGURED") {
    return {
      id: "stripe_saas",
      label: "Stripe SaaS subscription",
      group: "CORE_OPERATING",
      status,
      requirement: GO_LIVE_CARD_REQUIREMENTS.stripe_saas,
      currentState: "SaaS Stripe billing is not configured on this environment.",
      whatWorks: "Existing business records stay on file.",
      whatDoesNot: "Owner checkout for TBBT software cannot start until platform billing is configured.",
      ownerNextAction: "Ask the platform operator to configure SaaS Stripe. Do not paste keys into TBBT.",
      settingsHref: "/settings?section=tbbt-billing",
    };
  }
  return {
    id: "stripe_saas",
    label: "Stripe SaaS subscription",
    group: "CORE_OPERATING",
    status: "PARTIAL",
    requirement: GO_LIVE_CARD_REQUIREMENTS.stripe_saas,
    currentState:
      input.entitlementState === "payment_problem"
        ? "The TBBT subscription has a payment problem. Operating access continues while Billing is updated."
        : "SaaS billing is only partly ready (price, secret, or app URL).",
    whatWorks: "Recorded business data is retained.",
    whatDoesNot: "New checkout or a clean paid period may still be blocked.",
    ownerNextAction: "Open TBBT Billing to see the current entitlement. This page does not retry a charge.",
    settingsHref: "/settings?section=tbbt-billing",
  };
}

function stripeConnectCard(input: GoLiveInput["connect"]): GoLiveCard {
  const status = classifyStripeConnect(input);
  const base = {
    id: "stripe_connect" as const,
    label: "Stripe Connect customer payments",
    group: "PAYMENTS" as const,
    requirement: GO_LIVE_CARD_REQUIREMENTS.stripe_connect,
    settingsHref: "/settings?section=estimates-payments",
  };
  if (status === "LIVE") {
    return {
      ...base,
      status,
      currentState: "Customers can pay deposits and invoices online.",
      whatWorks: "Card checkout for sent invoices and material deposits is live. Manual Mark Paid still works.",
      whatDoesNot: "This is not TBBT software billing. Connect is required only if accepting customer card payments online.",
      ownerNextAction: "No Connect action is needed from this page.",
    };
  }
  if (status === "READY") {
    return {
      ...base,
      status,
      currentState: "Stripe Connect is ready to collect cards once checkout links can resolve.",
      whatWorks: "The connected account can charge. Cash, check, and Zelle Mark Paid still work. TBBT still operates without online cards.",
      whatDoesNot: "Pay buttons stay hidden until the app URL is set. Connect is required only if accepting customer card payments online.",
      ownerNextAction: "Ask the platform operator to set the public app URL. Do not start a new connection from this page.",
    };
  }
  if (status === "PARTIAL") {
    return {
      ...base,
      status,
      currentState: "Stripe Connect setup is incomplete. Required only if accepting customer card payments online.",
      whatWorks: "Cash, check, and Zelle can still be recorded with Mark Paid. TBBT still operates without online cards.",
      whatDoesNot: "Customers cannot finish card checkout yet.",
      ownerNextAction: "Finish Stripe onboarding from Estimates & Payments when you are ready. This page does not start onboarding.",
    };
  }
  if (status === "NOT_CONFIGURED") {
    return {
      ...base,
      status,
      currentState: "Stripe Connect is not configured on this TBBT environment. Required only if accepting customer card payments online.",
      whatWorks: "Cash, check, and Zelle Mark Paid still record payments. TBBT still operates without online cards.",
      whatDoesNot: "Customer card deposits and invoice cards are unavailable. Disconnected Connect does not mean TBBT cannot operate.",
      ownerNextAction: "Ask the platform operator to set the Connect secret. Do not paste keys into TBBT.",
    };
  }
  return {
    ...base,
    status: "DISCONNECTED",
    currentState: "Stripe Connect is not connected for this business. Required only if accepting customer card payments online.",
    whatWorks: "Cash, check, and Zelle Mark Paid still record payments. TBBT still operates without online cards.",
    whatDoesNot: "Customer card deposits and invoice cards are unavailable until Connect is finished. Disconnected Connect does not mean TBBT cannot operate.",
    ownerNextAction: "Connect Stripe from Estimates & Payments when you want card checkout. This page does not start that flow.",
  };
}

function resendCard(emailConfigured: boolean): GoLiveCard {
  const status = classifyResend(emailConfigured);
  if (status === "LIVE") {
    return {
      id: "resend",
      label: "Resend email",
      group: "COMMUNICATIONS",
      status,
      requirement: GO_LIVE_CARD_REQUIREMENTS.resend,
      currentState: "Platform email delivery is configured.",
      whatWorks: "Transactional customer email can send when a usable address exists.",
      whatDoesNot: "API keys are not shown. SMS is a separate capability.",
      ownerNextAction: "No email connection is needed from this page.",
      settingsHref: "/settings?section=communications",
    };
  }
  return {
    id: "resend",
    label: "Resend email",
    group: "COMMUNICATIONS",
    status: "UNAVAILABLE",
    requirement: GO_LIVE_CARD_REQUIREMENTS.resend,
    currentState: "Email delivery is unavailable.",
    whatWorks: "In-app records, public links, and copy-to-share URLs still work.",
    whatDoesNot: "TBBT cannot send customer email until Resend and a from-address are configured.",
    ownerNextAction: "Ask the platform operator to configure Resend. Do not paste API keys into TBBT.",
    settingsHref: "/settings?section=communications",
  };
}

function r2Card(r2Configured: boolean): GoLiveCard {
  const status = classifyR2(r2Configured);
  if (status === "LIVE") {
    return {
      id: "r2",
      label: "R2 / storage",
      group: "STORAGE",
      status,
      requirement: GO_LIVE_CARD_REQUIREMENTS.r2,
      currentState: "Platform object storage is configured.",
      whatWorks: "Intake, job, and website photo uploads can use platform storage.",
      whatDoesNot: "Storage credentials are not shown.",
      ownerNextAction: "No storage connection is needed from this page.",
      settingsHref: "/settings?section=website-photos",
    };
  }
  return {
    id: "r2",
    label: "R2 / storage",
    group: "STORAGE",
    status: "NOT_CONFIGURED",
    requirement: GO_LIVE_CARD_REQUIREMENTS.r2,
    currentState: "R2 storage is not configured.",
    whatWorks: "Jobs, requests, and records without new photo upload still exist.",
    whatDoesNot: "Intake and job photo upload are unavailable.",
    ownerNextAction: "Ask the platform operator to configure R2. Do not paste access keys into TBBT.",
    settingsHref: "/settings?section=website-photos",
  };
}

function twilioCard(input: GoLiveInput["twilio"]): GoLiveCard {
  const status = classifyTwilioSms(input);
  if (status === "READY") {
    return {
      id: "twilio_sms",
      label: "Twilio SMS",
      group: "COMMUNICATIONS",
      status,
      requirement: "OPTIONAL",
      currentState: "A dedicated sending number is assigned and platform SMS credentials exist.",
      whatWorks: "Operational SMS can be attempted for consented customers when a workflow calls it.",
      whatDoesNot:
        "Paid department SMS compose is not a live storefront add-on. Environment credentials alone never mean every SMS feature is live.",
      ownerNextAction: "No SMS connection is started from this page.",
      settingsHref: "/settings?section=communications",
    };
  }
  if (status === "PARTIAL") {
    return {
      id: "twilio_sms",
      label: "Twilio SMS",
      group: "COMMUNICATIONS",
      status,
      requirement: "OPTIONAL",
      currentState: input.platformConfigured
        ? "Twilio credentials exist. A dedicated business number or live SMS add-on is not fully in place."
        : "SMS is only partly available.",
      whatWorks: "Email and in-app customer records still work. SMS remains optional.",
      whatDoesNot:
        "Do not treat all SMS features as live because an environment variable exists. Department SMS compose is not a live purchasable add-on.",
      ownerNextAction: "Assign a dedicated business number in the existing messaging setup when you want outbound SMS. This page does not provision numbers.",
      settingsHref: "/settings?section=communications",
    };
  }
  return {
    id: "twilio_sms",
    label: "Twilio SMS",
    group: "COMMUNICATIONS",
    status: "UNAVAILABLE",
    requirement: "OPTIONAL",
    currentState: "SMS delivery is unavailable.",
    whatWorks: "Email (when configured) and in-app records still work. The product degrades without SMS.",
    whatDoesNot: "TBBT will not invent SMS delivery. Twilio is optional.",
    ownerNextAction: "No action is required to operate. SMS can stay unavailable.",
    settingsHref: "/settings?section=communications",
  };
}

function aiCard(aiConnected: boolean): GoLiveCard {
  const status = classifyAiProvider(aiConnected);
  if (status === "READY") {
    return {
      id: "ai_provider",
      label: "AI provider",
      group: "AI",
      status,
      requirement: "OPTIONAL",
      currentState: "An AI provider is connected.",
      whatWorks: "Provider synthesis can run for entitled Coach/Chief-of-Staff asks. Recorded facts stay the source of truth.",
      whatDoesNot: "API keys and account IDs are not shown. A provider name alone is not proof of a live model.",
      ownerNextAction: "No AI connection is started from this page.",
      settingsHref: "/settings?section=overview",
    };
  }
  return {
    id: "ai_provider",
    label: "AI provider",
    group: "AI",
    status: "DISCONNECTED",
    requirement: "OPTIONAL",
    currentState: "No AI provider is connected.",
    whatWorks: "Recorded Coach facts remain available; provider-generated synthesis is unavailable.",
    whatDoesNot: "TBBT will not invent model output. Deterministic Coach still works.",
    ownerNextAction: "No action is required. AI is optional.",
    settingsHref: "/settings?section=overview",
  };
}

function domainCard(input: GoLiveDomainInput): GoLiveCard {
  const status = classifyCustomDomain(input);
  if (status === "LIVE") {
    return {
      id: "custom_domain",
      label: "Custom / public domain",
      group: "OPTIONAL_PLANNED",
      status,
      requirement: "OPTIONAL",
      currentState: `Verified custom host: ${input.verifiedHostname}.`,
      whatWorks: "The verified hostname can resolve to this business's public site.",
      whatDoesNot: "TBBT does not purchase domains or change DNS from this page.",
      ownerNextAction: "No domain verification is started from this page.",
      settingsHref: "/settings?section=website-publish",
    };
  }
  if (status === "PARTIAL") {
    const hostname = input.unverifiedHostname ?? input.failedHostname;
    return {
      id: "custom_domain",
      label: "Custom / public domain",
      group: "OPTIONAL_PLANNED",
      status,
      requirement: "OPTIONAL",
      currentState: input.failedHostname
        ? `Custom host ${hostname} failed verification.`
        : `Custom host ${hostname} is on file but unverified.`,
      whatWorks: "The public /hire site for this business slug still works.",
      whatDoesNot: "Unverified hosts never route. This page does not mark a hostname verified.",
      ownerNextAction: "Finish DNS with your registrar when you want a custom domain. Publishing stays a separate owner action.",
      settingsHref: "/settings?section=website-publish",
    };
  }
  return {
    id: "custom_domain",
    label: "Custom / public domain",
    group: "OPTIONAL_PLANNED",
    status: "NOT_CONFIGURED",
    requirement: "OPTIONAL",
    currentState: "No custom-domain binding is on file.",
    whatWorks: "Customers can still use the public /hire site for this business slug.",
    whatDoesNot: "A branded custom hostname is not configured. TBBT does not buy domains.",
    ownerNextAction: "Optional. Add DNS later if you want a custom host. Not required to operate.",
    settingsHref: "/settings?section=website-publish",
  };
}

function financeCard(): GoLiveCard {
  return {
    id: "finance_bank",
    label: "Finance / bank",
    group: "OPTIONAL_PLANNED",
    status: classifyFinanceBank(),
    requirement: "OPTIONAL",
    currentState: "Bank and accounting connections are disconnected placeholders.",
    whatWorks: "Recorded invoices, payments, and expenses still exist inside TBBT.",
    whatDoesNot: "Live bank sync is not connected. TBBT will not invent a cash balance.",
    ownerNextAction: "No bank connection is available. Do not expect a feed from this page.",
    settingsHref: "/settings?section=banking",
  };
}

function supplierCard(): GoLiveCard {
  return {
    id: "supplier_commerce",
    label: "Supplier commerce",
    group: "OPTIONAL_PLANNED",
    status: classifySupplierCommerce(),
    requirement: "OPTIONAL",
    currentState: "Supplier commerce is disconnected.",
    whatWorks: "Recorded supplier prices may exist.",
    whatDoesNot: "Live stock/ordering is not connected. TBBT does not log into retailer accounts.",
    ownerNextAction: "No retailer login is started from this page.",
    settingsHref: "/settings?section=vendors",
  };
}

function esignCard(): GoLiveCard {
  return {
    id: "esign",
    label: "E-sign",
    group: "OPTIONAL_PLANNED",
    status: classifyEsign(),
    requirement: "OPTIONAL",
    currentState: "E-sign is a disconnected placeholder.",
    whatWorks: "You can still record an external signature or upload a signed file in Business Protection.",
    whatDoesNot: "No live e-sign provider is connected. TBBT will not invent a digital signature.",
    ownerNextAction: "No e-sign connection is available from this page.",
    settingsHref: "/settings?section=documents",
  };
}

function voiceCard(): GoLiveCard {
  return {
    id: "voice_receptionist",
    label: "Voice receptionist",
    group: "COMMUNICATIONS",
    status: classifyVoiceReceptionist(),
    requirement: "OPTIONAL",
    currentState: "Voice is not connected.",
    whatWorks: "Caller lookup, missed-call notes, and owner proposals can stay manual.",
    whatDoesNot: VOICE_NOT_CONNECTED_REASON,
    ownerNextAction: "No voice provider is connected. No action is required to operate.",
    settingsHref: "/settings?section=communications",
  };
}

function socialCard(): GoLiveCard {
  return {
    id: "social_publishing",
    label: "Social publishing",
    group: "OPTIONAL_PLANNED",
    status: classifySocialPublishing(),
    requirement: "OPTIONAL",
    currentState: "Social publishing is disconnected.",
    whatWorks: "Internal marketing drafts and recorded permissions still exist.",
    whatDoesNot: "TBBT does not publish autonomously to Facebook, Instagram, or Google.",
    ownerNextAction: "No social connection is available. Publishing stays manual and disconnected.",
    settingsHref: "/settings?section=marketing",
  };
}

function buildGroup(id: GoLiveGroup, cards: GoLiveCard[]): GoLiveLaunchGroup {
  const grouped = cards.filter((card) => card.group === id);
  const requirement = goLiveGroupRequirement(grouped);
  return {
    id,
    label: GO_LIVE_GROUP_LABELS[id],
    summary: GO_LIVE_GROUP_SUMMARIES[id],
    requirement,
    requirementLabel: GO_LIVE_GROUP_REQUIREMENT_LABELS[requirement],
    cards: grouped,
    liveCount: grouped.filter((card) => card.status === "LIVE").length,
    readyCount: grouped.filter((card) => card.status === "READY").length,
    remainingCount: grouped.filter((card) => card.status !== "LIVE" && card.status !== "READY").length,
    totalCount: grouped.length,
  };
}

export function buildGoLiveCenter(input: GoLiveInput): GoLiveCenter {
  const cards: GoLiveCard[] = [
    stripeSaasCard(input.saas),
    stripeConnectCard(input.connect),
    resendCard(input.emailConfigured),
    r2Card(input.r2Configured),
    twilioCard(input.twilio),
    aiCard(input.aiConnected),
    domainCard(input.domain),
    financeCard(),
    supplierCard(),
    esignCard(),
    voiceCard(),
    socialCard(),
  ];
  const groups = GO_LIVE_GROUPS.map((id) => buildGroup(id, cards));
  const requiredCards = cards.filter((card) => card.requirement === "REQUIRED");
  const conditionalCards = cards.filter((card) => card.requirement === "CONDITIONAL");
  const optionalCards = cards.filter((card) => card.requirement === "OPTIONAL");
  const center: GoLiveCenter = {
    cards,
    groups,
    requiredCards,
    conditionalCards,
    optionalCards,
    requiredLiveCount: requiredCards.filter((card) => card.status === "LIVE").length,
    requiredReadyCount: requiredCards.filter((card) => card.status === "READY").length,
    requiredRemainingCount: requiredCards.filter(
      (card) => card.status !== "LIVE" && card.status !== "READY",
    ).length,
    disclaimer: GO_LIVE_NO_SCORE_DISCLAIMER,
    readOnly: true,
  };
  assertGoLiveProjectionSafe(center);
  return center;
}

export function goLiveCardById(center: GoLiveCenter, id: GoLiveCapabilityId) {
  return center.cards.find((card) => card.id === id) ?? null;
}

/**
 * Walk a rendered projection and fail if secret-looking keys or values
 * appear. Used by the builder and by check scripts.
 */
export function assertGoLiveProjectionSafe(
  value: unknown,
  forbiddenValues: readonly string[] = [],
) {
  const needles = forbiddenValues.map((item) => item.trim()).filter((item) => item.length >= 4);
  walkProjection(value, needles, []);
}

function walkProjection(value: unknown, needles: readonly string[], path: string[]) {
  if (value == null) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value);
    if (SECRET_VALUE_PATTERN.test(text)) {
      throw new Error(`Go-live projection leaked a secret-looking value at ${path.join(".") || "root"}.`);
    }
    const lower = text.toLowerCase();
    for (const needle of needles) {
      if (needle && lower.includes(needle.toLowerCase())) {
        throw new Error(`Go-live projection leaked a forbidden value at ${path.join(".") || "root"}.`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkProjection(item, needles, [...path, String(index)]));
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        throw new Error(`Go-live projection leaked secret-looking key ${key}.`);
      }
      walkProjection(child, needles, [...path, key]);
    }
  }
}

export function serializeGoLiveProjection(center: GoLiveCenter) {
  assertGoLiveProjectionSafe(center);
  return JSON.stringify(center);
}

/**
 * Central TBBT SaaS entitlement. Pages and actions should read this
 * instead of scattering subscription checks. Stripe Connect is unrelated.
 *
 * This task enforces a management-console banner plus this resolver.
 * Viewing retained business records stays allowed. Per-action mutation
 * locks and field-app gating are deferred to a later task.
 */
import type { PrismaClient } from "@prisma/client";
import { isCollProRenoSlug } from "@/lib/public-site";
import { trialDaysRemaining } from "@/lib/saas-billing/founder-price";
import { ensureSaasBillingSchema } from "@/lib/saas-billing/schema";
import { SAAS_SUBSCRIPTION_STATUS_NONE } from "@/lib/saas-billing/types";

export const SAAS_ENTITLEMENT_STATES = [
  "trial_active",
  "subscribed_active",
  "payment_problem",
  "subscription_required",
  "legacy_exempt",
] as const;

export type SaasEntitlementState = (typeof SAAS_ENTITLEMENT_STATES)[number];

export type SaasEntitlementRow = {
  status: string | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  founderEligible: boolean;
  founderConvertedAt: Date | null;
  founderEligibilityEndedAt: Date | null;
  legacyExempt: boolean;
};

export type SaasEntitlement = {
  state: SaasEntitlementState;
  canOperate: boolean;
  requiresSubscription: boolean;
  trialActive: boolean;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
  founderEligible: boolean;
  founderConvertedAt: string | null;
  founderEligibilityEndedAt: string | null;
  legacyExempt: boolean;
  label: string;
  detail: string;
};

const PAYMENT_PROBLEM_STATUSES = new Set(["past_due", "unpaid", "paused"]);
const SUBSCRIBED_STATUSES = new Set(["active", "trialing"]);

export function resolveSaasEntitlement(input: {
  slug: string;
  row: SaasEntitlementRow | null;
  now?: Date;
}): SaasEntitlement {
  const now = input.now ?? new Date();
  const row = input.row;
  const trialStartedAt = row?.trialStartedAt ?? null;
  const trialEndsAt = row?.trialEndsAt ?? null;
  const founderEligible = row?.founderEligible ?? false;
  const base = {
    trialStartedAt: trialStartedAt?.toISOString() ?? null,
    trialEndsAt: trialEndsAt?.toISOString() ?? null,
    trialDaysRemaining: trialDaysRemaining(trialEndsAt, now),
    founderEligible,
    founderConvertedAt: row?.founderConvertedAt?.toISOString() ?? null,
    founderEligibilityEndedAt: row?.founderEligibilityEndedAt?.toISOString() ?? null,
    legacyExempt: row?.legacyExempt ?? false,
  };

  if (isCollProRenoSlug(input.slug)) {
    return {
      ...base,
      state: "legacy_exempt",
      canOperate: true,
      requiresSubscription: false,
      trialActive: false,
      legacyExempt: true,
      label: "Existing TBBT tenant",
      detail: "This business was already running before Founder Plan trials and is not restricted.",
    };
  }

  const status = row?.status ?? SAAS_SUBSCRIPTION_STATUS_NONE;
  if (SUBSCRIBED_STATUSES.has(status)) {
    return {
      ...base,
      state: "subscribed_active",
      canOperate: true,
      requiresSubscription: false,
      trialActive: false,
      label: "Subscribed",
      detail: "TBBT software access is covered by an active subscription.",
    };
  }
  if (PAYMENT_PROBLEM_STATUSES.has(status)) {
    return {
      ...base,
      state: "payment_problem",
      canOperate: true,
      requiresSubscription: false,
      trialActive: false,
      label: "Payment problem",
      detail: "The TBBT subscription has a payment problem. Operating access continues while this is resolved in Billing.",
    };
  }
  if (trialEndsAt && now < trialEndsAt) {
    const days = trialDaysRemaining(trialEndsAt, now) ?? 0;
    return {
      ...base,
      state: "trial_active",
      canOperate: true,
      requiresSubscription: false,
      trialActive: true,
      label: "Founder trial",
      detail: `Founder Plan trial is active. ${days} day${days === 1 ? "" : "s"} remaining. No credit card is required to continue the trial.`,
    };
  }
  if (trialEndsAt && now >= trialEndsAt) {
    return {
      ...base,
      state: "subscription_required",
      canOperate: false,
      requiresSubscription: true,
      trialActive: false,
      label: "Subscription required",
      detail: "The Founder Plan trial has ended. Business data is retained. Subscribe from TBBT Billing to keep operating.",
    };
  }

  return {
    ...base,
    state: "legacy_exempt",
    canOperate: true,
    requiresSubscription: false,
    trialActive: false,
    legacyExempt: row?.legacyExempt ?? true,
    label: "Existing TBBT tenant",
    detail: "This business is not on a Founder trial and is not restricted by subscription billing.",
  };
}

export async function loadSaasEntitlement(
  db: PrismaClient,
  business: { id: string; slug: string },
  now = new Date(),
): Promise<SaasEntitlement> {
  await ensureSaasBillingSchema(db);
  const row = await db.businessSaasSubscription.findUnique({
    where: { businessId: business.id },
    select: {
      status: true,
      trialStartedAt: true,
      trialEndsAt: true,
      founderEligible: true,
      founderConvertedAt: true,
      founderEligibilityEndedAt: true,
      legacyExempt: true,
    },
  });
  return resolveSaasEntitlement({ slug: business.slug, row, now });
}

export class SaasSubscriptionRequiredError extends Error {
  constructor(message = "A TBBT subscription is required to do that.") {
    super(message);
    this.name = "SaasSubscriptionRequiredError";
  }
}

export function assertSaasOperatingEntitlement(entitlement: SaasEntitlement) {
  if (!entitlement.canOperate) {
    throw new SaasSubscriptionRequiredError();
  }
}

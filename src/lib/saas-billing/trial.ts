/**
 * Local Founder Plan trial. No Stripe Customer, Subscription, or card
 * is created to begin the 30-day trial.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { isCollProRenoSlug } from "@/lib/public-site";
import { founderTrialWindow } from "@/lib/saas-billing/founder-price";
import { ensureSaasBillingTablesAndColumns } from "@/lib/saas-billing/schema";
import { SAAS_SUBSCRIPTION_STATUS_NONE } from "@/lib/saas-billing/types";
import { writeSettingsAuditLog } from "@/lib/settings-ops";

type BillingClient = PrismaClient | Prisma.TransactionClient;

export async function startFounderTrialIfEligible(
  db: PrismaClient,
  input: {
    businessId: string;
    slug: string;
    changedByMembershipId?: string | null;
    now?: Date;
  },
) {
  await ensureSaasBillingTablesAndColumns(db);
  if (isCollProRenoSlug(input.slug)) {
    return { started: false as const, reason: "collpro_exempt" as const };
  }

  const existing = await db.businessSaasSubscription.findUnique({
    where: { businessId: input.businessId },
  });
  if (existing?.trialStartedAt) {
    return { started: false as const, reason: "trial_already_started" as const };
  }
  if (existing?.legacyExempt) {
    return { started: false as const, reason: "legacy_exempt" as const };
  }
  if (existing?.stripeCustomerId || existing?.stripeSubscriptionId) {
    return { started: false as const, reason: "billing_record_exists" as const };
  }

  const { trialStartedAt, trialEndsAt } = founderTrialWindow(input.now);
  if (!existing) {
    await db.businessSaasSubscription.create({
      data: {
        businessId: input.businessId,
        status: SAAS_SUBSCRIPTION_STATUS_NONE,
        trialStartedAt,
        trialEndsAt,
        founderEligible: true,
        legacyExempt: false,
      },
    });
  } else {
    await db.businessSaasSubscription.update({
      where: { businessId: input.businessId },
      data: {
        trialStartedAt,
        trialEndsAt,
        founderEligible: true,
        legacyExempt: false,
      },
    });
  }

  if (input.changedByMembershipId) {
    await writeSettingsAuditLog(db, {
      businessId: input.businessId,
      changedByMembershipId: input.changedByMembershipId,
      settingArea: "saas-billing",
      settingKey: "founderTrialStarted",
      previousValue: null,
      newValue: trialEndsAt.toISOString(),
    });
  }

  return {
    started: true as const,
    reason: "started" as const,
    trialStartedAt,
    trialEndsAt,
  };
}

export function founderFieldsForSubscriptionStatus(input: {
  current: {
    founderEligible: boolean;
    founderConvertedAt: Date | null;
    founderEligibilityEndedAt: Date | null;
  } | null;
  nextStatus: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const current = input.current;
  if (!current?.founderEligible || current.founderEligibilityEndedAt) {
    return null;
  }
  if (input.nextStatus === "active" || input.nextStatus === "trialing") {
    if (current.founderConvertedAt) return null;
    return { founderConvertedAt: now };
  }
  if (input.nextStatus === "canceled" || input.nextStatus === "incomplete_expired") {
    return {
      founderEligible: false,
      founderEligibilityEndedAt: now,
    };
  }
  return null;
}

export async function applyFounderSubscriptionTransition(
  db: BillingClient,
  businessId: string,
  nextStatus: string,
) {
  const current = await db.businessSaasSubscription.findUnique({
    where: { businessId },
    select: {
      founderEligible: true,
      founderConvertedAt: true,
      founderEligibilityEndedAt: true,
    },
  });
  const patch = founderFieldsForSubscriptionStatus({ current, nextStatus });
  if (!patch) return;
  await db.businessSaasSubscription.update({
    where: { businessId },
    data: patch,
  });
}

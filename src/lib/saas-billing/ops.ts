/**
 * TBBT SaaS subscription billing operations.
 *
 * OWNER starts platform Checkout (mode: subscription). Stripe/webhook
 * state is authoritative. Browser success redirects never mark a
 * Business subscribed. Connect accounts, invoice Checkout, and deposit
 * Checkout are out of this module.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import { getAppUrl } from "@/lib/mail";
import { getStripeSecretKey } from "@/lib/payments/config";
import {
  getSaasPriceId,
  isSaasBillingConfigured,
  SAAS_BILLING_SETTINGS_HREF,
  TBBT_SAAS_PLAN_CODE,
  TBBT_SAAS_PLAN_NAME,
} from "@/lib/saas-billing/config";
import { parseSaasBillingEvent } from "@/lib/saas-billing/events";
import type { ParsedSaasBillingEvent, SaasSubscriptionSnapshot } from "@/lib/saas-billing/types";
import {
  isBlockingSaasStatus,
  SAAS_SUBSCRIPTION_STATUS_NONE,
  SaasBillingError,
  saasStatusLabel,
} from "@/lib/saas-billing/types";
import { getSaasBillingProvider } from "@/lib/saas-billing/provider";
import { ensureSaasBillingSchema } from "@/lib/saas-billing/schema";
import { writeSettingsAuditLog } from "@/lib/settings-ops";

type BillingClient = PrismaClient | Prisma.TransactionClient;

export type SaasBillingSnapshot = {
  planCode: string;
  planName: string;
  status: string;
  statusLabel: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  configured: boolean;
  appUrlConfigured: boolean;
  checkoutPossible: boolean;
  portalPossible: boolean;
};

function billingSettingsUrl(query = "") {
  const origin = getAppUrl();
  const path = `${SAAS_BILLING_SETTINGS_HREF}${query}`;
  if (!origin) return path;
  return `${origin}${path}`;
}

async function loadRow(db: BillingClient, businessId: string) {
  return db.businessSaasSubscription.findUnique({
    where: { businessId },
  });
}

async function upsertRow(
  db: BillingClient,
  businessId: string,
  data: Partial<SaasSubscriptionSnapshot> & { stripeCustomerId?: string | null },
) {
  const current = await loadRow(db, businessId);
  if (!current) {
    return db.businessSaasSubscription.create({
      data: {
        businessId,
        stripeCustomerId: data.stripeCustomerId ?? null,
        stripeSubscriptionId: data.stripeSubscriptionId ?? null,
        stripePriceId: data.stripePriceId ?? null,
        status: data.status ?? SAAS_SUBSCRIPTION_STATUS_NONE,
        currentPeriodEnd: data.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: data.cancelAtPeriodEnd ?? false,
      },
    });
  }
  return db.businessSaasSubscription.update({
    where: { businessId },
    data: {
      ...(data.stripeCustomerId !== undefined
        ? { stripeCustomerId: data.stripeCustomerId }
        : {}),
      ...(data.stripeSubscriptionId !== undefined
        ? { stripeSubscriptionId: data.stripeSubscriptionId }
        : {}),
      ...(data.stripePriceId !== undefined ? { stripePriceId: data.stripePriceId } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.currentPeriodEnd !== undefined
        ? { currentPeriodEnd: data.currentPeriodEnd }
        : {}),
      ...(data.cancelAtPeriodEnd !== undefined
        ? { cancelAtPeriodEnd: data.cancelAtPeriodEnd }
        : {}),
    },
  });
}

export async function loadSaasBillingSnapshot(
  db: PrismaClient,
  businessId: string,
): Promise<SaasBillingSnapshot> {
  await ensureSaasBillingSchema(db);
  const row = await loadRow(db, businessId);
  const fakeAdapter = process.env.TBBT_SAAS_BILLING_ADAPTER === "fake";
  const stripeReady = fakeAdapter || Boolean(getStripeSecretKey());
  const configured = isSaasBillingConfigured() && stripeReady;
  const appUrlConfigured = Boolean(getAppUrl());
  const status = row?.status ?? SAAS_SUBSCRIPTION_STATUS_NONE;
  return {
    planCode: TBBT_SAAS_PLAN_CODE,
    planName: TBBT_SAAS_PLAN_NAME,
    status,
    statusLabel: saasStatusLabel(status),
    stripeCustomerId: row?.stripeCustomerId ?? null,
    stripeSubscriptionId: row?.stripeSubscriptionId ?? null,
    stripePriceId: row?.stripePriceId ?? getSaasPriceId(),
    currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    configured,
    appUrlConfigured,
    checkoutPossible: configured && appUrlConfigured && !isBlockingSaasStatus(status),
    portalPossible: Boolean(row?.stripeCustomerId) && stripeReady && appUrlConfigured,
  };
}

export async function startSaasSubscriptionCheckout(
  db: PrismaClient,
  access: BusinessAccess,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");
  await ensureSaasBillingSchema(db);

  if (!isSaasBillingConfigured()) {
    throw new SaasBillingError("TBBT subscription billing is not configured on this environment.");
  }
  const priceId = getSaasPriceId() ?? (process.env.TBBT_SAAS_BILLING_ADAPTER === "fake" ? "price_saas_test" : null);
  if (!priceId) {
    throw new SaasBillingError("TBBT subscription price is not configured.");
  }
  const appUrl = getAppUrl();
  if (!appUrl) {
    throw new SaasBillingError("App URL is not configured, so Checkout cannot return to TBBT.");
  }

  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { id: true, name: true },
  });
  if (!business) {
    throw new SaasBillingError("Business was not found.");
  }

  const current = await loadRow(db, access.businessId);
  if (isBlockingSaasStatus(current?.status)) {
    throw new SaasBillingError("This business already has a TBBT subscription.");
  }

  const provider = getSaasBillingProvider();
  let customerId = current?.stripeCustomerId ?? null;
  if (!customerId) {
    const owner = await db.membership.findFirst({
      where: { businessId: access.businessId, role: "OWNER", active: true },
      select: { user: { select: { email: true } } },
      orderBy: { createdAt: "asc" },
    });
    const created = await provider.createCustomer({
      businessId: access.businessId,
      name: business.name,
      email: owner?.user.email ?? access.workspace.user?.email ?? null,
    });
    customerId = created.id;
    await upsertRow(db, access.businessId, {
      stripeCustomerId: customerId,
      status: current?.status ?? SAAS_SUBSCRIPTION_STATUS_NONE,
    });
  }

  const blocking = await provider.listBlockingSubscriptions(customerId);
  if (blocking.length > 0) {
    throw new SaasBillingError("This business already has a TBBT subscription.");
  }

  const session = await provider.createSubscriptionCheckout({
    businessId: access.businessId,
    customerId,
    priceId,
    successUrl: billingSettingsUrl("&checkout=success"),
    cancelUrl: billingSettingsUrl("&checkout=canceled"),
  });

  await writeSettingsAuditLog(db, {
    businessId: access.businessId,
    changedByMembershipId: access.workspace.membership.id,
    settingArea: "saas-billing",
    settingKey: "checkoutStarted",
    previousValue: current?.status ?? SAAS_SUBSCRIPTION_STATUS_NONE,
    newValue: session.id,
  });

  return { url: session.url, checkoutSessionId: session.id, customerId };
}

export async function startSaasBillingPortal(
  db: PrismaClient,
  access: BusinessAccess,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");
  await ensureSaasBillingSchema(db);

  const appUrl = getAppUrl();
  if (!appUrl) {
    throw new SaasBillingError("App URL is not configured, so Billing Portal cannot return to TBBT.");
  }
  const current = await loadRow(db, access.businessId);
  if (!current?.stripeCustomerId) {
    throw new SaasBillingError("Subscribe to TBBT before opening the billing portal.");
  }

  const provider = getSaasBillingProvider();
  return provider.createBillingPortalSession({
    customerId: current.stripeCustomerId,
    returnUrl: `${appUrl}${SAAS_BILLING_SETTINGS_HREF}`,
  });
}

async function resolveBusinessId(
  db: BillingClient,
  parsed: ParsedSaasBillingEvent,
) {
  if (parsed.businessId) {
    const owned = await db.business.findFirst({
      where: { id: parsed.businessId },
      select: { id: true },
    });
    if (owned) return owned.id;
  }
  if (parsed.snapshot.stripeSubscriptionId) {
    const bySub = await db.businessSaasSubscription.findFirst({
      where: { stripeSubscriptionId: parsed.snapshot.stripeSubscriptionId },
      select: { businessId: true },
    });
    if (bySub) return bySub.businessId;
  }
  if (parsed.snapshot.stripeCustomerId) {
    const byCustomer = await db.businessSaasSubscription.findFirst({
      where: { stripeCustomerId: parsed.snapshot.stripeCustomerId },
      select: { businessId: true },
    });
    if (byCustomer) return byCustomer.businessId;
  }
  return null;
}

export async function applyParsedSaasBillingEvent(
  db: PrismaClient,
  parsed: ParsedSaasBillingEvent,
) {
  await ensureSaasBillingSchema(db);

  const existingEvent = await db.saasBillingWebhookEvent.findUnique({
    where: { stripeEventId: parsed.stripeEventId },
    select: { id: true },
  });
  if (existingEvent) {
    return { applied: false as const, reason: "already_processed" as const, businessId: null };
  }

  const businessId = await resolveBusinessId(db, parsed);
  if (!businessId) {
    return { applied: false as const, reason: "unknown_business" as const, businessId: null };
  }

  const current = await loadRow(db, businessId);
  const isSubscriptionEvent = parsed.eventType.startsWith("customer.subscription");
  const incomingStatus = parsed.snapshot.status || current?.status || SAAS_SUBSCRIPTION_STATUS_NONE;
  const keepExistingStatus =
    !isSubscriptionEvent &&
    current != null &&
    current.status !== SAAS_SUBSCRIPTION_STATUS_NONE &&
    current.status !== "incomplete";
  const nextStatus = keepExistingStatus ? current.status : incomingStatus;
  await upsertRow(db, businessId, {
    stripeCustomerId: parsed.snapshot.stripeCustomerId ?? current?.stripeCustomerId ?? null,
    stripeSubscriptionId:
      parsed.snapshot.stripeSubscriptionId ?? current?.stripeSubscriptionId ?? null,
    stripePriceId: parsed.snapshot.stripePriceId ?? current?.stripePriceId ?? null,
    status: nextStatus,
    currentPeriodEnd: parsed.snapshot.currentPeriodEnd ?? current?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: isSubscriptionEvent
      ? parsed.snapshot.cancelAtPeriodEnd
      : current?.cancelAtPeriodEnd ?? false,
  });

  try {
    await db.saasBillingWebhookEvent.create({
      data: {
        stripeEventId: parsed.stripeEventId,
        eventType: parsed.eventType,
        businessId,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { applied: false as const, reason: "already_processed" as const, businessId };
    }
    throw error;
  }

  return { applied: true as const, reason: "updated" as const, businessId };
}

export async function applySaasBillingStripeEvent(
  db: PrismaClient,
  event: unknown,
) {
  const parsed = parseSaasBillingEvent(event);
  if (!parsed) {
    return { applied: false as const, reason: "ignored" as const, businessId: null };
  }
  return applyParsedSaasBillingEvent(db, parsed);
}

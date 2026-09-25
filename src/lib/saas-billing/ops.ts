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
import {
  canonicalizePlanCode,
  getPlanDefinition,
  PLAN_CODES,
  PLAN_PUBLIC_STATUSES,
  type PlanCode,
} from "@/lib/product-catalog";
import {
  loadProductEntitlement,
  resolveCheckoutPriceId,
  resolveCompatiblePlanCode,
  resolvePlanCodeFromPriceId,
  resolveWebhookPlanCode,
  type ProductEntitlement,
} from "@/lib/product-entitlements";
import {
  getSaasPriceId,
  isFakeSaasBillingAdapterEnabled,
  SAAS_BILLING_SETTINGS_HREF,
  TBBT_SAAS_PLAN_CODE,
  TBBT_SAAS_PLAN_NAME,
} from "@/lib/saas-billing/config";
import { parseSaasBillingEvent } from "@/lib/saas-billing/events";
import {
  inspectConfiguredFounderPrice,
  TBBT_FOUNDER_PLAN_PRICE_LABEL,
} from "@/lib/saas-billing/founder-price";
import { resolveSaasEntitlement, type SaasEntitlement } from "@/lib/saas-billing/entitlement";
import {
  resolveSaasBillingReadiness,
  type SaasBillingReadinessReason,
} from "@/lib/saas-billing/readiness";
import { applyFounderSubscriptionTransition } from "@/lib/saas-billing/trial";
import {
  isStaleSaasStripeEvent,
  isSaasSubscriptionObjectEvent,
  resolveNextSaasStatus,
} from "@/lib/saas-billing/lifecycle";
import type { ParsedSaasBillingEvent, SaasSubscriptionSnapshot } from "@/lib/saas-billing/types";
import {
  isBlockingSaasStatus,
  isSaasSubscribedStatus,
  SAAS_SUBSCRIPTION_STATUS_NONE,
  SaasBillingError,
  saasStatusLabel,
} from "@/lib/saas-billing/types";
import { getSaasBillingProvider } from "@/lib/saas-billing/provider";
import { ensureSaasBillingSchema } from "@/lib/saas-billing/schema";
import { writeSettingsAuditLog } from "@/lib/settings-ops";

type BillingClient = PrismaClient | Prisma.TransactionClient;

export type SaasBillingAvailablePlan = {
  code: PlanCode;
  name: string;
  publicStatus: string;
  checkoutEligible: boolean;
  purchasable: boolean;
  priceConfigured: boolean;
  priceLabel: string | null;
};

export type SaasBillingSnapshot = {
  planCode: string;
  planName: string;
  catalogPlanCode: PlanCode;
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
  planChangePossible: boolean;
  billingReadinessReason: SaasBillingReadinessReason;
  billingNotReadyMessage: string | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
  founderEligible: boolean;
  founderConvertedAt: string | null;
  founderEligibilityEndedAt: string | null;
  founderPriceLabel: string;
  showFounderPrice: boolean;
  founderPriceWarning: string | null;
  entitlement: SaasEntitlement;
  product: {
    capabilities: string[];
    addons: Array<{ code: string; displayName: string; status: string }>;
    limits: Record<string, number | null>;
  };
  availablePlans: SaasBillingAvailablePlan[];
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
  data: Partial<SaasSubscriptionSnapshot> & {
    stripeCustomerId?: string | null;
    lastStripeEventCreatedAt?: Date | null;
    planCode?: string | null;
  },
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
        lastStripeEventCreatedAt: data.lastStripeEventCreatedAt ?? null,
        planCode: data.planCode ?? null,
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
      ...(data.cancelAtPeriodEnd !== undefined && data.cancelAtPeriodEnd !== null
        ? { cancelAtPeriodEnd: data.cancelAtPeriodEnd }
        : {}),
      ...(data.lastStripeEventCreatedAt !== undefined
        ? { lastStripeEventCreatedAt: data.lastStripeEventCreatedAt }
        : {}),
      ...(data.planCode !== undefined ? { planCode: data.planCode } : {}),
    },
  });
}

function requestedPlanCode(raw?: string | null): PlanCode {
  if (!raw) return PLAN_CODES.FOUNDER;
  const canonical = canonicalizePlanCode(raw);
  if (!canonical) {
    throw new SaasBillingError("Unknown TBBT plan.");
  }
  return canonical;
}

function assertPlanCheckoutAllowed(planCode: PlanCode, priceId: string | null) {
  const plan = getPlanDefinition(planCode);
  const fake = isFakeSaasBillingAdapterEnabled();
  if (!fake && !plan.checkoutEligible) {
    throw new SaasBillingError(`${plan.displayName} is not available for checkout.`);
  }
  if (!fake && plan.publicStatus !== PLAN_PUBLIC_STATUSES.LIVE) {
    throw new SaasBillingError(`${plan.displayName} is not available for checkout.`);
  }
  if (!priceId) {
    throw new SaasBillingError("TBBT subscription price is not configured.");
  }
  const mapped = resolvePlanCodeFromPriceId(priceId);
  if (mapped && mapped !== planCode) {
    throw new SaasBillingError("The configured price does not belong to that TBBT plan.");
  }
}

export async function loadSaasBillingSnapshot(
  db: PrismaClient,
  businessId: string,
): Promise<SaasBillingSnapshot> {
  await ensureSaasBillingSchema(db);
  const [row, business, founderPrice] = await Promise.all([
    loadRow(db, businessId),
    db.business.findFirst({
      where: { id: businessId },
      select: { slug: true },
    }),
    inspectConfiguredFounderPrice(),
  ]);
  const readiness = resolveSaasBillingReadiness({ founderPrice });
  const status = row?.status ?? SAAS_SUBSCRIPTION_STATUS_NONE;
  const entitlement = resolveSaasEntitlement({
    slug: business?.slug ?? "",
    row: row
      ? {
          status: row.status,
          trialStartedAt: row.trialStartedAt,
          trialEndsAt: row.trialEndsAt,
          founderEligible: row.founderEligible,
          founderConvertedAt: row.founderConvertedAt,
          founderEligibilityEndedAt: row.founderEligibilityEndedAt,
          legacyExempt: row.legacyExempt,
          cancelAtPeriodEnd: row.cancelAtPeriodEnd,
          currentPeriodEnd: row.currentPeriodEnd,
        }
      : null,
  });
  const product: ProductEntitlement | null = business
    ? await loadProductEntitlement(db, businessId)
    : null;
  const catalogPlanCode =
    product?.planCode ??
    resolveCompatiblePlanCode({
      planCode: row?.planCode,
      stripePriceId: row?.stripePriceId,
      founderEligible: row?.founderEligible,
      founderConvertedAt: row?.founderConvertedAt,
      trialStartedAt: row?.trialStartedAt,
      legacyExempt: row?.legacyExempt,
      resolvePricePlanCode: resolvePlanCodeFromPriceId,
    });
  const plan = getPlanDefinition(catalogPlanCode);
  const fake = isFakeSaasBillingAdapterEnabled();
  const availablePlans = ([
    PLAN_CODES.STARTER,
    PLAN_CODES.FOUNDER,
    PLAN_CODES.BUSINESS,
    PLAN_CODES.ENTERPRISE,
  ] as const).map((code) => {
    const definition = getPlanDefinition(code);
    const priceId = resolveCheckoutPriceId(code);
    const purchasable =
      (fake || (definition.checkoutEligible && definition.publicStatus === PLAN_PUBLIC_STATUSES.LIVE)) &&
      Boolean(priceId);
    return {
      code,
      name: definition.displayName,
      publicStatus: definition.publicStatus,
      checkoutEligible: definition.checkoutEligible || fake,
      purchasable,
      priceConfigured: Boolean(priceId),
      priceLabel: definition.approvedDisplayPrice?.label ?? null,
    };
  });
  const founderPurchasable = availablePlans.find((item) => item.code === PLAN_CODES.FOUNDER)?.purchasable;
  return {
    planCode: catalogPlanCode === PLAN_CODES.FOUNDER ? TBBT_SAAS_PLAN_CODE : catalogPlanCode,
    planName: plan.displayName || TBBT_SAAS_PLAN_NAME,
    catalogPlanCode,
    status,
    statusLabel: saasStatusLabel(status),
    stripeCustomerId: row?.stripeCustomerId ?? null,
    stripeSubscriptionId: row?.stripeSubscriptionId ?? null,
    stripePriceId: row?.stripePriceId ?? getSaasPriceId(),
    currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    configured: readiness.configured,
    appUrlConfigured: readiness.appUrlConfigured,
    checkoutPossible: readiness.checkoutReady && !isBlockingSaasStatus(status) && Boolean(founderPurchasable),
    portalPossible: Boolean(row?.stripeCustomerId) && readiness.portalReady,
    planChangePossible:
      Boolean(row?.stripeSubscriptionId) &&
      isSaasSubscribedStatus(status) &&
      (fake || readiness.configured),
    billingReadinessReason: readiness.reason,
    billingNotReadyMessage: readiness.ownerMessage,
    trialStartedAt: entitlement.trialStartedAt,
    trialEndsAt: entitlement.trialEndsAt,
    trialDaysRemaining: entitlement.trialDaysRemaining,
    founderEligible: entitlement.founderEligible,
    founderConvertedAt: entitlement.founderConvertedAt,
    founderEligibilityEndedAt: entitlement.founderEligibilityEndedAt,
    founderPriceLabel: TBBT_FOUNDER_PLAN_PRICE_LABEL,
    showFounderPrice: founderPrice.showFounderPrice,
    founderPriceWarning: founderPrice.warning,
    entitlement,
    product: {
      capabilities: product?.capabilities ?? [],
      addons: (product?.addons ?? []).map((addon) => ({
        code: addon.code,
        displayName: addon.displayName,
        status: addon.status,
      })),
      limits: Object.fromEntries(
        Object.entries(product?.limits ?? {}).map(([key, value]) => [key, value.effective]),
      ),
    },
    availablePlans,
  };
}

export async function startSaasSubscriptionCheckout(
  db: PrismaClient,
  access: BusinessAccess,
  input: { planCode?: string | null } = {},
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");
  await ensureSaasBillingSchema(db);

  const planCode = requestedPlanCode(input.planCode);
  const founderPrice = await inspectConfiguredFounderPrice();
  const appUrl = getAppUrl();
  const readiness = resolveSaasBillingReadiness({ founderPrice, appUrl });
  if (planCode === PLAN_CODES.FOUNDER && !readiness.checkoutReady) {
    throw new SaasBillingError(
      readiness.ownerMessage ??
        "TBBT subscription billing is not configured correctly on this environment.",
    );
  }
  if (planCode !== PLAN_CODES.FOUNDER && !isFakeSaasBillingAdapterEnabled() && !readiness.configured) {
    throw new SaasBillingError(
      readiness.ownerMessage ??
        "TBBT subscription billing is not configured correctly on this environment.",
    );
  }
  const priceId = resolveCheckoutPriceId(planCode);
  assertPlanCheckoutAllowed(planCode, priceId);

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
    priceId: priceId!,
    planCode: planCode === PLAN_CODES.FOUNDER ? TBBT_SAAS_PLAN_CODE : planCode,
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
  const readiness = resolveSaasBillingReadiness({ appUrl });
  if (!readiness.portalReady || !appUrl) {
    throw new SaasBillingError(
      readiness.ownerMessage ??
        "TBBT subscription billing is not configured correctly on this environment.",
    );
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
  if (isStaleSaasStripeEvent(current?.lastStripeEventCreatedAt, parsed.stripeEventCreatedAt)) {
    try {
      await db.saasBillingWebhookEvent.create({
        data: {
          stripeEventId: parsed.stripeEventId,
          eventType: parsed.eventType,
          businessId,
          stripeEventCreatedAt: parsed.stripeEventCreatedAt,
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
    return { applied: false as const, reason: "stale_event" as const, businessId };
  }

  const incomingStatus = parsed.snapshot.status || current?.status || SAAS_SUBSCRIPTION_STATUS_NONE;
  const nextStatus = resolveNextSaasStatus({
    eventType: parsed.eventType,
    incomingStatus,
    currentStatus: current?.status,
  });
  const nextCancelAtPeriodEnd = isSaasSubscriptionObjectEvent(parsed.eventType)
    ? parsed.snapshot.cancelAtPeriodEnd === true
    : parsed.snapshot.cancelAtPeriodEnd != null
      ? parsed.snapshot.cancelAtPeriodEnd
      : current?.cancelAtPeriodEnd ?? false;
  const nextPriceId = parsed.snapshot.stripePriceId ?? current?.stripePriceId ?? null;
  const nextPlanCode = resolveWebhookPlanCode({
    stripePriceId: nextPriceId,
    currentPlanCode: current?.planCode ?? parsed.snapshot.planCode,
  });
  await upsertRow(db, businessId, {
    stripeCustomerId: parsed.snapshot.stripeCustomerId ?? current?.stripeCustomerId ?? null,
    stripeSubscriptionId:
      parsed.snapshot.stripeSubscriptionId ?? current?.stripeSubscriptionId ?? null,
    stripePriceId: nextPriceId,
    status: nextStatus,
    currentPeriodEnd: parsed.snapshot.currentPeriodEnd ?? current?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: nextCancelAtPeriodEnd,
    lastStripeEventCreatedAt:
      parsed.stripeEventCreatedAt ?? current?.lastStripeEventCreatedAt ?? null,
    planCode: nextPlanCode,
  });
  await applyFounderSubscriptionTransition(
    db,
    businessId,
    nextStatus,
    nextCancelAtPeriodEnd,
  );

  try {
    await db.saasBillingWebhookEvent.create({
      data: {
        stripeEventId: parsed.stripeEventId,
        eventType: parsed.eventType,
        businessId,
        stripeEventCreatedAt: parsed.stripeEventCreatedAt,
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

export async function requestSaasPlanChange(
  db: PrismaClient,
  access: BusinessAccess,
  input: { planCode?: string | null },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");
  await ensureSaasBillingSchema(db);

  const planCode = requestedPlanCode(input.planCode);
  const priceId = resolveCheckoutPriceId(planCode);
  assertPlanCheckoutAllowed(planCode, priceId);
  if (planCode === PLAN_CODES.FOUNDER) {
    const founderPrice = await inspectConfiguredFounderPrice();
    const readiness = resolveSaasBillingReadiness({ founderPrice, appUrl: getAppUrl() });
    if (!isFakeSaasBillingAdapterEnabled() && !readiness.checkoutReady) {
      throw new SaasBillingError(
        readiness.ownerMessage ??
          "TBBT subscription billing is not configured correctly on this environment.",
      );
    }
  }

  const current = await loadRow(db, access.businessId);
  if (!current?.stripeSubscriptionId) {
    throw new SaasBillingError("Subscribe to TBBT before changing plans.");
  }
  if (!isSaasSubscribedStatus(current.status) && !isBlockingSaasStatus(current.status)) {
    throw new SaasBillingError("There is no active TBBT subscription to change.");
  }

  const provider = getSaasBillingProvider();
  const changed = await provider.changeSubscriptionPrice({
    subscriptionId: current.stripeSubscriptionId,
    priceId: priceId!,
    planCode: planCode === PLAN_CODES.FOUNDER ? TBBT_SAAS_PLAN_CODE : planCode,
  });

  await writeSettingsAuditLog(db, {
    businessId: access.businessId,
    changedByMembershipId: access.workspace.membership.id,
    settingArea: "saas-billing",
    settingKey: "planChangeRequested",
    previousValue: current.planCode ?? resolveCompatiblePlanCode({ planCode: current.planCode }),
    newValue: planCode,
  });

  return {
    requested: true as const,
    planCode,
    priceId: changed.priceId,
    subscriptionId: changed.subscriptionId,
    localPlanUnchanged: true as const,
  };
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

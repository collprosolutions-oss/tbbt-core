/**
 * Canonical TBBT SaaS billing readiness.
 *
 * Production Founder Checkout and Billing Portal fail closed when live
 * Stripe subscription billing is not ready. The fake adapter is never
 * treated as ready in Vercel production (see isFakeSaasBillingAdapterEnabled).
 *
 * This does not throw at import time and is not a website/build gate.
 * Public pages, signup, first-run, and operating entitlement stay on
 * their existing paths. Webhook signature secrets are required only by
 * the Stripe webhook route, not by Checkout/Portal start.
 *
 * Live Checkout readiness requires the caller to pass the result of
 * inspectConfiguredFounderPrice(). Omitting that inspection must not be
 * treated as checkout-ready. Global banners must not call inspect on
 * every page render; Checkout stays authoritative on TBBT Billing.
 */
import { getAppUrl } from "@/lib/mail";
import { getStripeSecretKey } from "@/lib/payments/config";
import {
  getSaasPriceId,
  isFakeSaasBillingAdapterEnabled,
} from "@/lib/saas-billing/config";
import type { FounderPriceInspection } from "@/lib/saas-billing/founder-price";
import {
  SAAS_BILLING_APP_URL_OWNER_MESSAGE,
  SAAS_BILLING_NOT_READY_OWNER_MESSAGE,
} from "@/lib/saas-billing/messages";

export type SaasBillingReadinessReason =
  | "ready"
  | "missing_price"
  | "missing_secret"
  | "missing_app_url"
  | "invalid_founder_price";

export type SaasBillingReadiness = {
  reason: SaasBillingReadinessReason;
  configured: boolean;
  stripeReady: boolean;
  appUrlConfigured: boolean;
  checkoutReady: boolean;
  portalReady: boolean;
  ownerMessage: string | null;
};

export type SaasBillingReadinessInput = {
  founderPrice?: Pick<FounderPriceInspection, "matchesFounderPrice" | "warning"> | null;
  appUrl?: string | null;
};

export function founderPriceBlocksCheckout(
  founderPrice?: Pick<FounderPriceInspection, "matchesFounderPrice"> | null,
) {
  return founderPrice?.matchesFounderPrice === false;
}

export function founderPriceInspectionProvided(
  founderPrice: SaasBillingReadinessInput["founderPrice"],
) {
  return founderPrice !== undefined;
}

export function resolveSaasBillingReadiness(
  input: SaasBillingReadinessInput = {},
): SaasBillingReadiness {
  const fake = isFakeSaasBillingAdapterEnabled();
  const priceId = getSaasPriceId();
  const secret = getStripeSecretKey();
  const appUrl = input.appUrl !== undefined ? input.appUrl : getAppUrl();
  const appUrlConfigured = Boolean(appUrl);
  const stripeReady = fake || Boolean(secret);
  const priceConfigured = fake || Boolean(priceId);
  const configured = stripeReady && priceConfigured;
  const invalidFounderPrice = founderPriceBlocksCheckout(input.founderPrice);
  const inspectionProvided = fake || founderPriceInspectionProvided(input.founderPrice);

  if (!priceConfigured) {
    return {
      reason: "missing_price",
      configured: false,
      stripeReady,
      appUrlConfigured,
      checkoutReady: false,
      portalReady: stripeReady && appUrlConfigured,
      ownerMessage: SAAS_BILLING_NOT_READY_OWNER_MESSAGE,
    };
  }
  if (!stripeReady) {
    return {
      reason: "missing_secret",
      configured: false,
      stripeReady: false,
      appUrlConfigured,
      checkoutReady: false,
      portalReady: false,
      ownerMessage: SAAS_BILLING_NOT_READY_OWNER_MESSAGE,
    };
  }
  if (invalidFounderPrice) {
    return {
      reason: "invalid_founder_price",
      configured,
      stripeReady,
      appUrlConfigured,
      checkoutReady: false,
      portalReady: appUrlConfigured,
      ownerMessage:
        input.founderPrice?.warning ?? SAAS_BILLING_NOT_READY_OWNER_MESSAGE,
    };
  }
  if (!appUrlConfigured) {
    return {
      reason: "missing_app_url",
      configured,
      stripeReady,
      appUrlConfigured: false,
      checkoutReady: false,
      portalReady: false,
      ownerMessage: SAAS_BILLING_APP_URL_OWNER_MESSAGE,
    };
  }
  return {
    reason: "ready",
    configured: true,
    stripeReady: true,
    appUrlConfigured: true,
    checkoutReady: inspectionProvided,
    portalReady: true,
    ownerMessage: null,
  };
}

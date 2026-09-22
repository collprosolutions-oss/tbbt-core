/**
 * Founder Plan display and Stripe Price alignment.
 *
 * Checkout always uses STRIPE_SAAS_PRICE_ID. The app may display the
 * approved Founder Plan amount of $49/month, but never invents a Price ID.
 */
import Stripe from "stripe";
import { getStripeSecretKey } from "@/lib/payments/config";
import { getSaasPriceId, isFakeSaasBillingAdapterEnabled } from "@/lib/saas-billing/config";

export const TBBT_FOUNDER_PLAN_AMOUNT_CENTS = 4900;
export const TBBT_FOUNDER_PLAN_CURRENCY = "usd";
export const TBBT_FOUNDER_PLAN_INTERVAL = "month";
export const TBBT_FOUNDER_PLAN_PRICE_LABEL = "$49/month";
export const TBBT_FOUNDER_TRIAL_DAYS = 30;
export const TBBT_FOUNDER_TRIAL_MS = TBBT_FOUNDER_TRIAL_DAYS * 24 * 60 * 60 * 1000;

export const TBBT_FOUNDER_PRICE_OPERATIONAL_REQUIREMENT =
  "Before production Checkout is enabled, create a recurring $49 USD/month Stripe Price and set STRIPE_SAAS_PRICE_ID to that Price ID. TBBT does not invent or hardcode a Stripe Price ID.";

export type FounderPriceInspection = {
  configuredPriceId: string | null;
  verified: boolean;
  matchesFounderPrice: boolean | null;
  stripeUnitAmount: number | null;
  stripeCurrency: string | null;
  stripeInterval: string | null;
  showFounderPrice: boolean;
  warning: string | null;
};

function isFounderRecurringPrice(price: {
  unit_amount: number | null;
  currency: string;
  recurring: { interval: string } | null;
}) {
  return (
    price.unit_amount === TBBT_FOUNDER_PLAN_AMOUNT_CENTS &&
    price.currency === TBBT_FOUNDER_PLAN_CURRENCY &&
    price.recurring?.interval === TBBT_FOUNDER_PLAN_INTERVAL
  );
}

export async function inspectConfiguredFounderPrice(): Promise<FounderPriceInspection> {
  const configuredPriceId = getSaasPriceId();
  if (isFakeSaasBillingAdapterEnabled()) {
    return {
      configuredPriceId,
      verified: false,
      matchesFounderPrice: null,
      stripeUnitAmount: null,
      stripeCurrency: null,
      stripeInterval: null,
      showFounderPrice: true,
      warning: null,
    };
  }
  const secret = getStripeSecretKey();
  if (!configuredPriceId) {
    return {
      configuredPriceId,
      verified: false,
      matchesFounderPrice: null,
      stripeUnitAmount: null,
      stripeCurrency: null,
      stripeInterval: null,
      showFounderPrice: true,
      warning: TBBT_FOUNDER_PRICE_OPERATIONAL_REQUIREMENT,
    };
  }
  if (!secret) {
    return {
      configuredPriceId,
      verified: false,
      matchesFounderPrice: null,
      stripeUnitAmount: null,
      stripeCurrency: null,
      stripeInterval: null,
      showFounderPrice: true,
      warning: null,
    };
  }
  try {
    const stripe = new Stripe(secret);
    const price = await stripe.prices.retrieve(configuredPriceId);
    const matchesFounderPrice = isFounderRecurringPrice({
      unit_amount: price.unit_amount,
      currency: price.currency,
      recurring: price.recurring ? { interval: price.recurring.interval } : null,
    });
    return {
      configuredPriceId,
      verified: true,
      matchesFounderPrice,
      stripeUnitAmount: price.unit_amount ?? null,
      stripeCurrency: price.currency,
      stripeInterval: price.recurring?.interval ?? null,
      showFounderPrice: matchesFounderPrice,
      warning: matchesFounderPrice
        ? null
        : "The configured Stripe Price does not match the approved Founder Plan of $49/month. Checkout still uses STRIPE_SAAS_PRICE_ID and will not pretend the charge is $49.",
    };
  } catch {
    return {
      configuredPriceId,
      verified: false,
      matchesFounderPrice: null,
      stripeUnitAmount: null,
      stripeCurrency: null,
      stripeInterval: null,
      showFounderPrice: true,
      warning: null,
    };
  }
}

export function founderTrialWindow(from = new Date()) {
  const trialStartedAt = from;
  const trialEndsAt = new Date(from.getTime() + TBBT_FOUNDER_TRIAL_MS);
  return { trialStartedAt, trialEndsAt };
}

export function trialDaysRemaining(trialEndsAt: Date | null | undefined, now = new Date()) {
  if (!trialEndsAt) return null;
  const ms = trialEndsAt.getTime() - now.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

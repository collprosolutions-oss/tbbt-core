import type {
  BusinessPaymentStatus,
  PaymentConnectionStatus,
} from "@/lib/payments/types";

export const PAYMENTS_SETTINGS_HREF = "/settings?section=estimates-payments";

export type PaymentsGoLiveBlocker =
  | "platform"
  | "app_url"
  | "connect"
  | "setup"
  | null;

export type PaymentsGoLiveExplanation = {
  onlineCheckoutPossible: boolean;
  showOwnerBanner: boolean;
  blocker: PaymentsGoLiveBlocker;
  headline: string;
  detail: string;
  settingsHref: typeof PAYMENTS_SETTINGS_HREF;
};

const SETTINGS_HREF = PAYMENTS_SETTINGS_HREF;

/**
 * Owner-facing honesty for first-release collections.
 *
 * Card checkout needs all three: platform Stripe keys, a canonical app URL
 * for success/cancel links, and a Connect account that can charge.
 * Manual Mark Paid stays available regardless.
 */
export function explainPaymentsGoLive(input: {
  platformConfigured: boolean;
  appUrlConfigured: boolean;
  paymentReady: boolean;
  status: PaymentConnectionStatus;
}): PaymentsGoLiveExplanation {
  const onlineCheckoutPossible =
    input.platformConfigured && input.appUrlConfigured && input.paymentReady;

  if (onlineCheckoutPossible) {
    return {
      onlineCheckoutPossible: true,
      showOwnerBanner: false,
      blocker: null,
      headline: "Customers can pay invoices and deposits online.",
      detail:
        "Card checkout is live. Cash, check, and Zelle can still be recorded with Mark Paid.",
      settingsHref: SETTINGS_HREF,
    };
  }

  if (!input.platformConfigured) {
    return {
      onlineCheckoutPossible: false,
      showOwnerBanner: true,
      blocker: "platform",
      headline: "Online card payments are not live",
      detail:
        "Customers cannot pay by card yet. Record cash, check, or Zelle with Mark Paid. Card checkout needs STRIPE_SECRET_KEY on this environment, then Connect Stripe in Settings.",
      settingsHref: SETTINGS_HREF,
    };
  }

  if (!input.appUrlConfigured) {
    return {
      onlineCheckoutPossible: false,
      showOwnerBanner: true,
      blocker: "app_url",
      headline: "Checkout links are not ready",
      detail:
        "Customer Pay buttons stay hidden until NEXT_PUBLIC_APP_URL is set (production: https://www.collproreno.com). Connect onboarding and checkout both need that URL. Record cash, check, or Zelle with Mark Paid until then.",
      settingsHref: SETTINGS_HREF,
    };
  }

  if (input.status === "setup_required") {
    return {
      onlineCheckoutPossible: false,
      showOwnerBanner: true,
      blocker: "setup",
      headline: "Finish Stripe setup to collect card payments",
      detail:
        "Complete Stripe onboarding in Settings. Cash, check, and Zelle Mark Paid still work.",
      settingsHref: SETTINGS_HREF,
    };
  }

  return {
    onlineCheckoutPossible: false,
    showOwnerBanner: true,
    blocker: "connect",
    headline: "Stripe is not connected",
    detail:
      "Connect Stripe in Settings so customers can pay deposits and invoices online. Until then, collect payment in person and use Mark Paid.",
    settingsHref: SETTINGS_HREF,
  };
}

export function explainPaymentsGoLiveFromStatus(
  payment: Pick<
    BusinessPaymentStatus,
    "platformConfigured" | "appUrlConfigured" | "paymentReady" | "status"
  >,
): PaymentsGoLiveExplanation {
  return explainPaymentsGoLive(payment);
}

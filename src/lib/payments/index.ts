export {
  getStripeSecretKey,
  getStripeWebhookSecret,
  isStripePlatformConfigured,
  STRIPE_CURRENCY,
} from "@/lib/payments/config";
export {
  isUnknownConnectedAccountError,
  redactStripeText,
  stripeConnectOnboardingFailureMessage,
  summarizeStripeError,
} from "@/lib/payments/stripe-errors";
export { parseCheckoutPaymentEvent } from "@/lib/payments/events";
export {
  explainMerchantReadiness,
  formatPaymentReadinessDebug,
  isMerchantPaymentReady,
  shouldOfferStripeOnboarding,
} from "@/lib/payments/readiness";
export type {
  PaymentReadinessBranch,
  PaymentReadinessDebug,
} from "@/lib/payments/readiness";
export {
  invoiceAmountToCents,
  invoiceDueCents,
  payDepositButtonLabel,
  payInvoiceButtonLabel,
} from "@/lib/payments/money";
export { getPaymentProvider, stripeConnectAvailable } from "@/lib/payments/provider";
export {
  applyVerifiedCheckoutPayment,
  reconcileEstimateDepositCheckout,
  reconcileProjectTokenCheckoutPayment,
  reconcileStripeCheckoutPayment,
  createCustomerDepositCheckout,
  createCustomerInvoiceCheckout,
  getBusinessPaymentStatus,
  PaymentError,
  paymentErrorMessage,
  shouldShowPayDeposit,
  shouldShowPayInvoice,
  startStripeConnectOnboarding,
} from "@/lib/payments/service";
export {
  explainPaymentsGoLive,
  explainPaymentsGoLiveFromStatus,
  PAYMENTS_SETTINGS_HREF,
} from "@/lib/payments/go-live";
export type {
  PaymentsGoLiveBlocker,
  PaymentsGoLiveExplanation,
} from "@/lib/payments/go-live";
export type {
  BusinessPaymentStatus,
  PaymentConnectionStatus,
  PaymentProvider,
  VerifiedCheckoutPayment,
} from "@/lib/payments/types";

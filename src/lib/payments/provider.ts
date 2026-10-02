import {
  isFakePaymentsAdapterEnabled,
  isStripePlatformConfigured,
} from "@/lib/payments/config";
import {
  createFakePaymentProvider,
  type FakePaymentProvider,
} from "@/lib/payments/fake";
import { createStripePaymentProvider } from "@/lib/payments/stripe-adapter";
import type { PaymentProvider } from "@/lib/payments/types";

let cached: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (!cached) {
    cached = isFakePaymentsAdapterEnabled()
      ? createFakePaymentProvider()
      : createStripePaymentProvider();
  }
  return cached;
}

/** Local/script fake adapter only. Null when Stripe is the live provider. */
export function getFakePaymentProvider(): FakePaymentProvider | null {
  if (!isFakePaymentsAdapterEnabled()) {
    return null;
  }
  return getPaymentProvider() as FakePaymentProvider;
}

export function stripeConnectAvailable(): boolean {
  return isStripePlatformConfigured();
}

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

type GlobalFakePayments = typeof globalThis & {
  tbbtFakePaymentProvider?: FakePaymentProvider;
};

let cached: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (isFakePaymentsAdapterEnabled()) {
    const globalForFake = globalThis as GlobalFakePayments;
    if (!globalForFake.tbbtFakePaymentProvider) {
      globalForFake.tbbtFakePaymentProvider = createFakePaymentProvider();
    }
    return globalForFake.tbbtFakePaymentProvider;
  }
  if (!cached) {
    cached = createStripePaymentProvider();
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

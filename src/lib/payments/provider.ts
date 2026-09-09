import {
  isFakePaymentsAdapterEnabled,
  isStripePlatformConfigured,
} from "@/lib/payments/config";
import { createFakePaymentProvider } from "@/lib/payments/fake";
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

export function stripeConnectAvailable(): boolean {
  return isStripePlatformConfigured();
}

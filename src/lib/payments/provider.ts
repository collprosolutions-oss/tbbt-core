import { isStripePlatformConfigured } from "@/lib/payments/config";
import { createStripePaymentProvider } from "@/lib/payments/stripe-adapter";
import type { PaymentProvider } from "@/lib/payments/types";

let cached: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (!cached) {
    cached = createStripePaymentProvider();
  }
  return cached;
}

export function stripeConnectAvailable(): boolean {
  return isStripePlatformConfigured();
}

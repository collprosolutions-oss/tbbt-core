import { isFakeSaasBillingAdapterEnabled } from "@/lib/saas-billing/config";
import { createFakeSaasBillingProvider } from "@/lib/saas-billing/fake";
import { createStripeSaasBillingProvider } from "@/lib/saas-billing/stripe";
import type { SaasBillingProvider } from "@/lib/saas-billing/types";

let cached: SaasBillingProvider | null = null;

export function getSaasBillingProvider(): SaasBillingProvider {
  if (!cached) {
    cached = isFakeSaasBillingAdapterEnabled()
      ? createFakeSaasBillingProvider()
      : createStripeSaasBillingProvider();
  }
  return cached;
}

export function resetSaasBillingProvider() {
  cached = null;
}

export function setSaasBillingProvider(provider: SaasBillingProvider | null) {
  cached = provider;
}

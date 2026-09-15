import { createFakeSaasBillingProvider } from "@/lib/saas-billing/fake";
import { createStripeSaasBillingProvider } from "@/lib/saas-billing/stripe";
import type { SaasBillingProvider } from "@/lib/saas-billing/types";

let cached: SaasBillingProvider | null = null;

export function getSaasBillingProvider(): SaasBillingProvider {
  if (!cached) {
    cached =
      process.env.TBBT_SAAS_BILLING_ADAPTER === "fake"
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

import type {
  CreateSaasCheckoutInput,
  CreateSaasCustomerInput,
  CreateSaasPortalInput,
  SaasBillingProvider,
  SaasCheckoutSessionResult,
} from "@/lib/saas-billing/types";
import { isBlockingSaasStatus, SaasBillingError } from "@/lib/saas-billing/types";

export type FakeSaasCustomer = {
  id: string;
  businessId: string;
  email: string | null;
  name: string;
};

export type FakeSaasSubscription = {
  id: string;
  customerId: string;
  priceId: string;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
};

export type FakeSaasCheckout = SaasCheckoutSessionResult & {
  businessId: string;
  customerId: string;
  priceId: string;
  mode: "subscription";
};

export type FakeSaasBillingProvider = SaasBillingProvider & {
  customers: Map<string, FakeSaasCustomer>;
  subscriptions: Map<string, FakeSaasSubscription>;
  checkouts: FakeSaasCheckout[];
  portalSessions: Array<{ customerId: string; url: string }>;
  failPortal: boolean;
  addSubscription(input: FakeSaasSubscription): void;
};

export function createFakeSaasBillingProvider(): FakeSaasBillingProvider {
  const customers = new Map<string, FakeSaasCustomer>();
  const subscriptions = new Map<string, FakeSaasSubscription>();
  const checkouts: FakeSaasCheckout[] = [];
  const portalSessions: Array<{ customerId: string; url: string }> = [];
  let customerSeq = 0;
  let sessionSeq = 0;
  let subscriptionSeq = 0;

  const provider: FakeSaasBillingProvider = {
    customers,
    subscriptions,
    checkouts,
    portalSessions,
    failPortal: false,
    addSubscription(input) {
      subscriptions.set(input.id, input);
    },
    async createCustomer(input: CreateSaasCustomerInput) {
      customerSeq += 1;
      const row: FakeSaasCustomer = {
        id: `cus_saas_${customerSeq}`,
        businessId: input.businessId,
        email: input.email,
        name: input.name,
      };
      customers.set(row.id, row);
      return { id: row.id };
    },
    async createSubscriptionCheckout(input: CreateSaasCheckoutInput) {
      if (!customers.has(input.customerId)) {
        throw new SaasBillingError("Stripe customer was not found.");
      }
      sessionSeq += 1;
      const result: FakeSaasCheckout = {
        id: `cs_saas_${sessionSeq}`,
        url: `https://checkout.stripe.test/subscribe/${sessionSeq}`,
        businessId: input.businessId,
        customerId: input.customerId,
        priceId: input.priceId,
        mode: "subscription",
      };
      checkouts.push(result);
      return { id: result.id, url: result.url };
    },
    async listBlockingSubscriptions(customerId: string) {
      return [...subscriptions.values()]
        .filter((row) => row.customerId === customerId && isBlockingSaasStatus(row.status))
        .map((row) => ({ id: row.id, status: row.status }));
    },
    async createBillingPortalSession(input: CreateSaasPortalInput) {
      if (provider.failPortal) {
        throw new SaasBillingError(
          "Stripe Billing Portal is not available on this Stripe account yet.",
        );
      }
      if (!customers.has(input.customerId)) {
        throw new SaasBillingError("Stripe customer was not found.");
      }
      const url = `https://billing.stripe.test/session/${input.customerId}`;
      portalSessions.push({ customerId: input.customerId, url });
      return { url };
    },
  };

  return provider;
}

export function nextFakeSubscriptionId(provider: FakeSaasBillingProvider) {
  return `sub_saas_${provider.subscriptions.size + 1}`;
}

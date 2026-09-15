import Stripe from "stripe";
import { getStripeSecretKey } from "@/lib/payments/config";
import { SAAS_CHECKOUT_PURPOSE } from "@/lib/saas-billing/config";
import type {
  CreateSaasCheckoutInput,
  CreateSaasCustomerInput,
  CreateSaasPortalInput,
  SaasBillingProvider,
} from "@/lib/saas-billing/types";
import { isBlockingSaasStatus, SaasBillingError } from "@/lib/saas-billing/types";

function requireStripe(): Stripe {
  const secret = getStripeSecretKey();
  if (!secret) {
    throw new SaasBillingError("Stripe is not configured.");
  }
  return new Stripe(secret);
}

function customerIdOf(value: string | { id?: string } | null | undefined) {
  if (typeof value === "string") return value;
  return value?.id ?? null;
}

export function createStripeSaasBillingProvider(): SaasBillingProvider {
  return {
    async createCustomer(input: CreateSaasCustomerInput) {
      const stripe = requireStripe();
      const customer = await stripe.customers.create({
        name: input.name,
        email: input.email || undefined,
        metadata: {
          purpose: SAAS_CHECKOUT_PURPOSE,
          businessId: input.businessId,
        },
      });
      return { id: customer.id };
    },

    async createSubscriptionCheckout(input: CreateSaasCheckoutInput) {
      const stripe = requireStripe();
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: input.customerId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.businessId,
        metadata: {
          purpose: SAAS_CHECKOUT_PURPOSE,
          businessId: input.businessId,
          priceId: input.priceId,
        },
        subscription_data: {
          metadata: {
            purpose: SAAS_CHECKOUT_PURPOSE,
            businessId: input.businessId,
          },
        },
      });
      if (!session.url) {
        throw new SaasBillingError("Stripe did not return a checkout URL.");
      }
      return { id: session.id, url: session.url };
    },

    async listBlockingSubscriptions(customerId: string) {
      const stripe = requireStripe();
      const listed = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 20,
      });
      return listed.data
        .filter((row) => isBlockingSaasStatus(row.status))
        .map((row) => ({ id: row.id, status: row.status }));
    },

    async createBillingPortalSession(input: CreateSaasPortalInput) {
      const stripe = requireStripe();
      try {
        const session = await stripe.billingPortal.sessions.create({
          customer: input.customerId,
          return_url: input.returnUrl,
        });
        if (!session.url) {
          throw new SaasBillingError("Stripe did not return a billing portal URL.");
        }
        return { url: session.url };
      } catch (error) {
        if (error instanceof SaasBillingError) throw error;
        throw new SaasBillingError(
          "Stripe Billing Portal is not available on this Stripe account yet.",
        );
      }
    },
  };
}

export function constructStripeWebhookEventWithSecrets(
  payload: string,
  signature: string,
  secrets: string[],
): Stripe.Event {
  const stripe = requireStripe();
  let lastError: unknown;
  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(payload, signature, secret);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Invalid signature.");
}

export { customerIdOf };

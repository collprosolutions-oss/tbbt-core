import Stripe from "stripe";
import { getStripeSecretKey } from "@/lib/payments/config";
import { parseCheckoutPaymentEvent } from "@/lib/payments/events";
import type {
  CreateConnectedAccountInput,
  CreateInvoiceCheckoutInput,
  CreateOnboardingLinkInput,
  PaymentProvider,
} from "@/lib/payments/types";
import { PAYMENT_PROVIDER_STRIPE } from "@/lib/payments/types";

function requireStripe(): Stripe {
  const secret = getStripeSecretKey();
  if (!secret) {
    throw new Error("Stripe is not configured.");
  }
  return new Stripe(secret);
}

function cardPaymentsActive(account: Stripe.V2.Core.Account): boolean {
  return account.configuration?.merchant?.capabilities?.card_payments?.status === "active";
}

export function createStripePaymentProvider(): PaymentProvider {
  return {
    id: PAYMENT_PROVIDER_STRIPE,

    async createConnectedAccount(input: CreateConnectedAccountInput) {
      const stripe = requireStripe();
      const account = await stripe.v2.core.accounts.create({
        display_name: input.displayName,
        contact_email: input.contactEmail || undefined,
        dashboard: "full",
        identity: {
          country: "us",
          entity_type: "company",
          business_details: {
            registered_name: input.displayName,
          },
        },
        configuration: {
          merchant: {
            capabilities: {
              card_payments: { requested: true },
            },
          },
        },
        defaults: {
          currency: "usd",
          responsibilities: {
            fees_collector: "stripe",
            losses_collector: "stripe",
          },
        },
        metadata: {
          tbbtBusinessId: input.businessId,
        },
        include: ["configuration.merchant"],
      });
      return { accountId: account.id };
    },

    async createAccountOnboardingLink(input: CreateOnboardingLinkInput) {
      const stripe = requireStripe();
      const link = await stripe.v2.core.accountLinks.create({
        account: input.accountId,
        use_case: {
          type: "account_onboarding",
          account_onboarding: {
            configurations: ["merchant"],
            collection_options: { fields: "eventually_due" },
            return_url: input.returnUrl,
            refresh_url: input.refreshUrl,
          },
        },
      });
      if (!link.url) {
        throw new Error("Stripe did not return an onboarding URL.");
      }
      return { url: link.url };
    },

    async getAccountReadiness(accountId: string) {
      const stripe = requireStripe();
      const account = await stripe.v2.core.accounts.retrieve(accountId, {
        include: ["configuration.merchant"],
      });
      return {
        accountId: account.id,
        chargesEnabled: cardPaymentsActive(account),
      };
    },

    async createInvoiceCheckoutSession(input: CreateInvoiceCheckoutInput) {
      const stripe = requireStripe();
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: input.currency,
                unit_amount: input.amountCents,
                product_data: { name: input.description },
              },
            },
          ],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          metadata: {
            invoiceId: input.invoiceId,
            businessId: input.businessId,
          },
          payment_intent_data: {
            metadata: {
              invoiceId: input.invoiceId,
              businessId: input.businessId,
            },
          },
        },
        { stripeAccount: input.connectedAccountId },
      );
      if (!session.url) {
        throw new Error("Stripe did not return a checkout URL.");
      }
      return {
        id: session.id,
        url: session.url,
        connectedAccountId: input.connectedAccountId,
        amountCents: input.amountCents,
        currency: input.currency,
      };
    },

    parseCheckoutPaymentEvent,
  };
}

export function constructStripeWebhookEvent(
  payload: string,
  signature: string,
  secret: string,
): Stripe.Event {
  const stripe = requireStripe();
  return stripe.webhooks.constructEvent(payload, signature, secret);
}

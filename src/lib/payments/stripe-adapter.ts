import Stripe from "stripe";
import { getStripeSecretKey } from "@/lib/payments/config";
import { parseCheckoutPaymentEvent } from "@/lib/payments/events";
import {
  explainMerchantReadiness,
  safeRetrieveErrorName,
} from "@/lib/payments/readiness";
import type {
  CreateConnectedAccountInput,
  CreateInvoiceCheckoutInput,
  CreateOnboardingLinkInput,
  PaymentProvider,
  VerifiedCheckoutPayment,
} from "@/lib/payments/types";
import { PAYMENT_PROVIDER_STRIPE } from "@/lib/payments/types";

function requireStripe(): Stripe {
  const secret = getStripeSecretKey();
  if (!secret) {
    throw new Error("Stripe is not configured.");
  }
  return new Stripe(secret);
}

const ACCOUNT_READINESS_INCLUDE = [
  "configuration.merchant",
  "requirements",
] as const;

/**
 * Deterministic invoice Checkout methods. Apple Pay / Google Pay stay
 * available through `card` when the customer device is eligible. Link is
 * omitted so Klarna-on-Link cannot appear.
 */
export const INVOICE_CHECKOUT_PAYMENT_METHOD_TYPES = [
  "card",
  "cashapp",
  "us_bank_account",
] as const;

function v1RequirementKeys(
  requirements: Stripe.Account.Requirements | null | undefined,
  field: "currently_due" | "past_due" | "pending_verification",
) {
  const values = requirements?.[field];
  if (!Array.isArray(values)) {
    return null;
  }
  return values.filter((value): value is string => typeof value === "string");
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
        include: [...ACCOUNT_READINESS_INCLUDE],
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
      let v2: Stripe.V2.Core.Account | null = null;
      let v2Error: string | null = null;
      try {
        v2 = await stripe.v2.core.accounts.retrieve(accountId, {
          include: [...ACCOUNT_READINESS_INCLUDE],
        });
      } catch (error) {
        v2Error = safeRetrieveErrorName(error);
      }

      let v1: Stripe.Account | null = null;
      let v1Error: string | null = null;
      try {
        v1 = await stripe.accounts.retrieve(accountId);
      } catch (error) {
        v1Error = safeRetrieveErrorName(error);
      }

      const cardPayments =
        v2?.configuration?.merchant?.capabilities?.card_payments;
      const debug = explainMerchantReadiness({
        cardPaymentsStatus:
          cardPayments?.status ?? v1?.capabilities?.card_payments ?? null,
        cardPaymentsStatusDetails: cardPayments?.status_details ?? null,
        requirementEntries: v2?.requirements?.entries ?? null,
        currentlyDueKeys: v1RequirementKeys(v1?.requirements, "currently_due"),
        pastDueKeys: v1RequirementKeys(v1?.requirements, "past_due"),
        pendingVerificationKeys: v1RequirementKeys(
          v1?.requirements,
          "pending_verification",
        ),
        v1ChargesEnabled: v1 ? v1.charges_enabled === true : null,
        detailsSubmitted: v1 ? v1.details_submitted === true : null,
        v1CardPaymentsCapability: v1?.capabilities?.card_payments ?? null,
        disabledReason: v1?.requirements?.disabled_reason ?? null,
        retrieveFailed: !v2 && !v1,
        retrieveError: !v2 && !v1 ? (v2Error ?? v1Error) : null,
      });
      console.info(
        "[payments] stripe readiness",
        JSON.stringify({
          branch: debug.branch,
          ready: debug.ready,
          cardPaymentsStatus: debug.cardPaymentsStatus,
          cardPaymentsStatusDetails: debug.cardPaymentsStatusDetails,
          chargesEnabled: debug.chargesEnabled,
          detailsSubmitted: debug.detailsSubmitted,
          disabledReason: debug.disabledReason,
          currentlyDueKeys: debug.currentlyDueKeys,
          pastDueKeys: debug.pastDueKeys,
          pendingVerificationKeys: debug.pendingVerificationKeys,
          retrieveError: debug.retrieveError,
          v2RetrieveError: v2 ? null : v2Error,
          v1RetrieveError: v1 ? null : v1Error,
        }),
      );

      return {
        accountId: v2?.id ?? v1?.id ?? accountId,
        chargesEnabled: debug.ready,
        debug,
      };
    },

    async createInvoiceCheckoutSession(input: CreateInvoiceCheckoutInput) {
      const stripe = requireStripe();
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          payment_method_types: [...INVOICE_CHECKOUT_PAYMENT_METHOD_TYPES],
          wallet_options: {
            link: { display: "never" },
          },
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
            connectedAccountId: input.connectedAccountId,
          },
          payment_intent_data: {
            metadata: {
              invoiceId: input.invoiceId,
              businessId: input.businessId,
              connectedAccountId: input.connectedAccountId,
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

    async findPaidInvoiceCheckout(input) {
      const stripe = requireStripe();
      const matchesInvoice = (session: Stripe.Checkout.Session) => {
        const metadata = session.metadata ?? {};
        return (
          session.payment_status === "paid" &&
          metadata.invoiceId === input.invoiceId &&
          metadata.businessId === input.businessId &&
          session.amount_total === input.amountCents &&
          session.currency === "usd"
        );
      };
      const toVerified = (
        session: Stripe.Checkout.Session,
      ): VerifiedCheckoutPayment | null => {
        if (!matchesInvoice(session)) {
          return null;
        }
        const paymentIntent =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.id;
        return {
          invoiceId: input.invoiceId,
          businessId: input.businessId,
          connectedAccountId: input.connectedAccountId,
          amountCents: input.amountCents,
          currency: "usd",
          paymentReference: paymentIntent,
          paymentStatus: "paid",
        };
      };

      if (input.checkoutSessionId) {
        try {
          const session = await stripe.checkout.sessions.retrieve(
            input.checkoutSessionId,
            undefined,
            { stripeAccount: input.connectedAccountId },
          );
          const verified = toVerified(session);
          if (verified) {
            return verified;
          }
        } catch {
          // Fall through to a recent-session list for webhook-missed payments.
        }
      }

      try {
        const listed = await stripe.checkout.sessions.list(
          { limit: 100, status: "complete" },
          { stripeAccount: input.connectedAccountId },
        );
        for (const session of listed.data) {
          const verified = toVerified(session);
          if (verified) {
            return verified;
          }
        }
      } catch {
        // Continue to PaymentIntent lookup for webhook-missed payments.
      }

      try {
        const intents = await stripe.paymentIntents.list(
          { limit: 100 },
          { stripeAccount: input.connectedAccountId },
        );
        for (const intent of intents.data) {
          const metadata = intent.metadata ?? {};
          if (
            intent.status === "succeeded" &&
            metadata.invoiceId === input.invoiceId &&
            metadata.businessId === input.businessId &&
            intent.amount === input.amountCents &&
            intent.currency === "usd"
          ) {
            return {
              invoiceId: input.invoiceId,
              businessId: input.businessId,
              connectedAccountId: input.connectedAccountId,
              amountCents: input.amountCents,
              currency: "usd",
              paymentReference: intent.id,
              paymentStatus: "paid",
            };
          }
        }
      } catch {
        return null;
      }
      return null;
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

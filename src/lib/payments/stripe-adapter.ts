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

/** Standalone BNPL types. Klarna-on-Link is a separate Link funding source. */
export const INVOICE_CHECKOUT_EXCLUDED_PAYMENT_METHODS = [
  "affirm",
  "klarna",
] as const;

export const INVOICE_CHECKOUT_PMC_NAME = "TBBT invoice checkout";

type InvoiceCheckoutDisplayPreference = {
  display_preference: { preference: "on" | "off" };
};

/** Invoice Checkout method set: keep card/wallets/Link/Cash App/bank, hide BNPL. */
export function invoiceCheckoutPaymentMethodPreferences(): {
  apple_pay: InvoiceCheckoutDisplayPreference;
  cashapp: InvoiceCheckoutDisplayPreference;
  card: InvoiceCheckoutDisplayPreference;
  google_pay: InvoiceCheckoutDisplayPreference;
  link: InvoiceCheckoutDisplayPreference;
  pay_by_bank: InvoiceCheckoutDisplayPreference;
  us_bank_account: InvoiceCheckoutDisplayPreference;
  affirm: InvoiceCheckoutDisplayPreference;
  klarna: InvoiceCheckoutDisplayPreference;
} {
  const on = { display_preference: { preference: "on" as const } };
  const off = { display_preference: { preference: "off" as const } };
  return {
    card: on,
    apple_pay: on,
    google_pay: on,
    link: on,
    cashapp: on,
    us_bank_account: on,
    pay_by_bank: on,
    affirm: off,
    klarna: off,
  };
}

async function resolveInvoiceCheckoutPaymentMethodConfiguration(
  stripe: Stripe,
  connectedAccountId: string,
): Promise<string | null> {
  const stripeAccount = { stripeAccount: connectedAccountId };
  const preferences = invoiceCheckoutPaymentMethodPreferences();

  try {
    const existing = await stripe.paymentMethodConfigurations.list(
      { limit: 100 },
      stripeAccount,
    );
    const named = existing.data.find(
      (config) => config.name === INVOICE_CHECKOUT_PMC_NAME && config.active,
    );
    const defaultConfig = existing.data.find((config) => config.is_default);
    if (defaultConfig && defaultConfig.id !== named?.id) {
      await stripe.paymentMethodConfigurations.update(
        defaultConfig.id,
        {
          affirm: preferences.affirm,
          klarna: preferences.klarna,
        },
        stripeAccount,
      );
    }
    if (named) {
      const updated = await stripe.paymentMethodConfigurations.update(
        named.id,
        preferences,
        stripeAccount,
      );
      return updated.id;
    }

    const created = await stripe.paymentMethodConfigurations.create(
      {
        name: INVOICE_CHECKOUT_PMC_NAME,
        ...preferences,
      },
      stripeAccount,
    );
    return created.id;
  } catch {
    return null;
  }
}

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
      const paymentMethodConfiguration =
        await resolveInvoiceCheckoutPaymentMethodConfiguration(
          stripe,
          input.connectedAccountId,
        );
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
          excluded_payment_method_types: [
            ...INVOICE_CHECKOUT_EXCLUDED_PAYMENT_METHODS,
          ],
          ...(paymentMethodConfiguration
            ? { payment_method_configuration: paymentMethodConfiguration }
            : {}),
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

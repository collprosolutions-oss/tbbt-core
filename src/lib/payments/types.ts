import type { Prisma } from "@prisma/client";
import type { PaymentReadinessDebug } from "@/lib/payments/readiness";

export const PAYMENT_PROVIDER_STRIPE = "stripe" as const;

export type PaymentConnectionStatus =
  | "not_connected"
  | "setup_required"
  | "connected";

export type ConnectedAccountReadiness = {
  accountId: string;
  chargesEnabled: boolean;
  debug?: PaymentReadinessDebug;
};

export type CreateConnectedAccountInput = {
  businessId: string;
  displayName: string;
  contactEmail?: string | null;
};

export type CreateOnboardingLinkInput = {
  accountId: string;
  returnUrl: string;
  refreshUrl: string;
};

export type CreateInvoiceCheckoutInput = {
  connectedAccountId: string;
  invoiceId: string;
  businessId: string;
  amountCents: number;
  currency: "usd";
  description: string;
  successUrl: string;
  cancelUrl: string;
};

export type CheckoutSessionResult = {
  id: string;
  url: string;
  connectedAccountId: string;
  amountCents: number;
  currency: string;
};

export type VerifiedCheckoutPayment = {
  invoiceId: string;
  businessId: string;
  connectedAccountId: string;
  amountCents: number;
  currency: string;
  paymentReference: string;
  paymentStatus: string;
};

/**
 * Smallest provider boundary. TBBT Core talks to this, not Stripe APIs.
 */
export type PaymentProvider = {
  id: typeof PAYMENT_PROVIDER_STRIPE;
  createConnectedAccount(
    input: CreateConnectedAccountInput,
  ): Promise<{ accountId: string }>;
  createAccountOnboardingLink(
    input: CreateOnboardingLinkInput,
  ): Promise<{ url: string }>;
  getAccountReadiness(accountId: string): Promise<ConnectedAccountReadiness>;
  createInvoiceCheckoutSession(
    input: CreateInvoiceCheckoutInput,
  ): Promise<CheckoutSessionResult>;
  parseCheckoutPaymentEvent(event: unknown): VerifiedCheckoutPayment | null;
};

export type BusinessPaymentStatus = {
  providerLabel: "Stripe";
  status: PaymentConnectionStatus;
  platformConfigured: boolean;
  stripeAccountId: string | null;
  paymentReady: boolean;
  readinessDebug?: PaymentReadinessDebug;
};

export type InvoiceAmount = Prisma.Decimal | { toString(): string } | number | string;

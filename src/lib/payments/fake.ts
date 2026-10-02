import { randomUUID } from "node:crypto";
import { parseCheckoutPaymentEvent } from "@/lib/payments/events";
import type {
  CheckoutSessionResult,
  CreateConnectedAccountInput,
  CreateDepositCheckoutInput,
  CreateInvoiceCheckoutInput,
  CreateOnboardingLinkInput,
  PaymentProvider,
  VerifiedCheckoutPayment,
} from "@/lib/payments/types";
import { PAYMENT_PROVIDER_STRIPE } from "@/lib/payments/types";

/** Local-only Stripe test checkout page. Never a live Stripe hostname. */
export const FAKE_STRIPE_TEST_CHECKOUT_PATH = "/payments/test-checkout";

export function isFakeCheckoutSessionId(value: string) {
  return /^cs_test_[A-Za-z0-9_-]{1,80}$/.test(value);
}

export function fakeStripeTestCheckoutUrl(sessionId: string, successUrl: string) {
  if (!isFakeCheckoutSessionId(sessionId)) {
    throw new Error("Invalid test checkout session.");
  }
  const origin = new URL(successUrl).origin;
  return `${origin}${FAKE_STRIPE_TEST_CHECKOUT_PATH}/${sessionId}`;
}

export function applyCheckoutSessionId(url: string, sessionId: string) {
  return url.replaceAll("{CHECKOUT_SESSION_ID}", sessionId);
}

export function isFakePaymentProvider(
  provider: PaymentProvider,
): provider is FakePaymentProvider {
  return (
    typeof (provider as FakePaymentProvider).completeCheckout === "function" &&
    typeof (provider as FakePaymentProvider).findCheckout === "function" &&
    Array.isArray((provider as FakePaymentProvider).checkouts)
  );
}

type GlobalFakePayments = typeof globalThis & {
  tbbtFakePaymentProvider?: FakePaymentProvider;
};

/** Process-wide fake adapter so Pay Invoice and test-checkout share sessions. */
export function getSharedFakePaymentProvider(): FakePaymentProvider {
  const globalForFake = globalThis as GlobalFakePayments;
  if (!globalForFake.tbbtFakePaymentProvider) {
    globalForFake.tbbtFakePaymentProvider = createFakePaymentProvider();
  }
  return globalForFake.tbbtFakePaymentProvider;
}

export type FakeAccountState = {
  accountId: string;
  chargesEnabled: boolean;
};

export type FakeCheckoutSession = CheckoutSessionResult & {
  invoiceId: string | null;
  estimateId: string | null;
  purpose: "invoice_balance" | "material_deposit";
  businessId: string;
  paid: boolean;
  successUrl: string;
  cancelUrl: string;
};

export type FakePaymentProvider = PaymentProvider & {
  accounts: Map<string, FakeAccountState>;
  checkouts: FakeCheckoutSession[];
  setChargesEnabled(accountId: string, chargesEnabled: boolean): void;
  completeCheckout(sessionId: string): void;
  findCheckout(sessionId: string): FakeCheckoutSession | null;
};

/**
 * Local/test only. Comma-separated connected account ids the fake adapter
 * may treat as charges-enabled when they were stored outside this process
 * (the portal verifier writes BusinessPaymentAccount, then `next start`
 * gets a fresh in-memory provider). Unknown ids stay not ready.
 * Ignored when VERCEL_ENV=production. The Stripe adapter never reads this.
 * A global "any unknown account is ready" switch is intentionally absent.
 */
export const FAKE_PAYMENT_READY_ACCOUNTS_ENV = "TBBT_FAKE_PAYMENT_READY_ACCOUNTS";

function explicitlyReadyFakeAccount(accountId: string) {
  if (process.env.VERCEL_ENV === "production") return false;
  const raw = process.env[FAKE_PAYMENT_READY_ACCOUNTS_ENV] ?? "";
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .includes(accountId);
}

export function createFakePaymentProvider(): FakePaymentProvider {
  const accounts = new Map<string, FakeAccountState>();
  const checkouts: FakeCheckoutSession[] = [];
  let accountSeq = 0;
  let sessionSeq = 0;

  function createCheckout(input: {
    connectedAccountId: string;
    businessId: string;
    amountCents: number;
    currency: string;
    purpose: "invoice_balance" | "material_deposit";
    invoiceId: string | null;
    estimateId: string | null;
    successUrl: string;
    cancelUrl: string;
  }): FakeCheckoutSession {
    if (chargesEnabledFor(input.connectedAccountId) !== true) {
      throw new Error("Connected account is not payment-ready.");
    }
    sessionSeq += 1;
    const id = `cs_test_${sessionSeq}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const result: FakeCheckoutSession = {
      id,
      url: fakeStripeTestCheckoutUrl(id, input.successUrl),
      connectedAccountId: input.connectedAccountId,
      amountCents: input.amountCents,
      currency: input.currency,
      invoiceId: input.invoiceId,
      estimateId: input.estimateId,
      purpose: input.purpose,
      businessId: input.businessId,
      paid: false,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    };
    checkouts.push(result);
    return result;
  }

  function chargesEnabledFor(accountId: string): boolean | null {
    const account = accounts.get(accountId);
    if (account) return account.chargesEnabled;
    if (explicitlyReadyFakeAccount(accountId)) return true;
    return null;
  }

  function toVerified(session: FakeCheckoutSession): VerifiedCheckoutPayment {
    return {
      purpose: session.purpose,
      invoiceId: session.invoiceId,
      estimateId: session.estimateId,
      checkoutSessionId: session.id,
      businessId: session.businessId,
      connectedAccountId: session.connectedAccountId,
      amountCents: session.amountCents,
      currency: session.currency,
      paymentReference: session.id,
      paymentStatus: "paid",
    };
  }

  return {
    id: PAYMENT_PROVIDER_STRIPE,
    accounts,
    checkouts,
    setChargesEnabled(accountId, chargesEnabled) {
      const existing = accounts.get(accountId);
      if (existing) {
        existing.chargesEnabled = chargesEnabled;
      } else {
        accounts.set(accountId, { accountId, chargesEnabled });
      }
    },
    completeCheckout(sessionId) {
      const session = checkouts.find((checkout) => checkout.id === sessionId);
      if (session) {
        session.paid = true;
      }
    },
    findCheckout(sessionId) {
      return checkouts.find((checkout) => checkout.id === sessionId) ?? null;
    },
    async createConnectedAccount(input: CreateConnectedAccountInput) {
      accountSeq += 1;
      const accountId = `acct_test_${input.businessId.slice(-6)}_${accountSeq}`;
      accounts.set(accountId, { accountId, chargesEnabled: false });
      return { accountId };
    },
    async createAccountOnboardingLink(input: CreateOnboardingLinkInput) {
      if (!accounts.has(input.accountId)) {
        const error = new Error(`No such account: '${input.accountId}'`);
        Object.assign(error, {
          type: "StripeInvalidRequestError",
          code: "not_found",
          statusCode: 404,
          param: "account",
          requestId: "req_test_not_found",
        });
        throw error;
      }
      return { url: `https://connect.stripe.test/setup/${input.accountId}` };
    },
    async getAccountReadiness(accountId: string) {
      const chargesEnabled = chargesEnabledFor(accountId);
      if (chargesEnabled === null) {
        throw new Error("Unknown connected account.");
      }
      return { accountId, chargesEnabled };
    },
    async createInvoiceCheckoutSession(input: CreateInvoiceCheckoutInput) {
      return createCheckout({
        ...input,
        purpose: "invoice_balance",
        invoiceId: input.invoiceId,
        estimateId: null,
      });
    },
    async createDepositCheckoutSession(input: CreateDepositCheckoutInput) {
      return createCheckout({
        ...input,
        purpose: "material_deposit",
        invoiceId: null,
        estimateId: input.estimateId,
      });
    },
    async findPaidInvoiceCheckout(input) {
      const matchesInvoice = (checkout: FakeCheckoutSession) =>
        checkout.paid &&
        checkout.purpose === "invoice_balance" &&
        checkout.connectedAccountId === input.connectedAccountId &&
        checkout.invoiceId === input.invoiceId &&
        checkout.businessId === input.businessId &&
        checkout.amountCents === input.amountCents;
      const session =
        (input.checkoutSessionId
          ? checkouts.find(
              (checkout) =>
                checkout.id === input.checkoutSessionId && matchesInvoice(checkout),
            )
          : undefined) ?? checkouts.find(matchesInvoice);
      return session ? toVerified(session) : null;
    },
    async findPaidDepositCheckout(input) {
      const matchesDeposit = (checkout: FakeCheckoutSession) =>
        checkout.paid &&
        checkout.purpose === "material_deposit" &&
        checkout.connectedAccountId === input.connectedAccountId &&
        checkout.estimateId === input.estimateId &&
        checkout.businessId === input.businessId &&
        checkout.amountCents === input.amountCents;
      const session =
        (input.checkoutSessionId
          ? checkouts.find(
              (checkout) =>
                checkout.id === input.checkoutSessionId && matchesDeposit(checkout),
            )
          : undefined) ?? checkouts.find(matchesDeposit);
      return session ? toVerified(session) : null;
    },
    parseCheckoutPaymentEvent,
  };
}

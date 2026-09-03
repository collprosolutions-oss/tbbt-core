import { parseCheckoutPaymentEvent } from "@/lib/payments/events";
import type {
  CheckoutSessionResult,
  CreateConnectedAccountInput,
  CreateInvoiceCheckoutInput,
  CreateOnboardingLinkInput,
  PaymentProvider,
} from "@/lib/payments/types";
import { PAYMENT_PROVIDER_STRIPE } from "@/lib/payments/types";

export type FakeAccountState = {
  accountId: string;
  chargesEnabled: boolean;
};

export type FakeCheckoutSession = CheckoutSessionResult & {
  invoiceId: string;
  businessId: string;
};

export type FakePaymentProvider = PaymentProvider & {
  accounts: Map<string, FakeAccountState>;
  checkouts: FakeCheckoutSession[];
  setChargesEnabled(accountId: string, chargesEnabled: boolean): void;
};

export function createFakePaymentProvider(): FakePaymentProvider {
  const accounts = new Map<string, FakeAccountState>();
  const checkouts: FakeCheckoutSession[] = [];
  let accountSeq = 0;
  let sessionSeq = 0;

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
    async createConnectedAccount(input: CreateConnectedAccountInput) {
      accountSeq += 1;
      const accountId = `acct_test_${input.businessId.slice(-6)}_${accountSeq}`;
      accounts.set(accountId, { accountId, chargesEnabled: false });
      return { accountId };
    },
    async createAccountOnboardingLink(input: CreateOnboardingLinkInput) {
      if (!accounts.has(input.accountId)) {
        throw new Error("Unknown connected account.");
      }
      return { url: `https://connect.stripe.test/setup/${input.accountId}` };
    },
    async getAccountReadiness(accountId: string) {
      const account = accounts.get(accountId);
      if (!account) {
        throw new Error("Unknown connected account.");
      }
      return {
        accountId: account.accountId,
        chargesEnabled: account.chargesEnabled,
      };
    },
    async createInvoiceCheckoutSession(input: CreateInvoiceCheckoutInput) {
      const account = accounts.get(input.connectedAccountId);
      if (!account?.chargesEnabled) {
        throw new Error("Connected account is not payment-ready.");
      }
      sessionSeq += 1;
      const result: FakeCheckoutSession = {
        id: `cs_test_${sessionSeq}`,
        url: `https://checkout.stripe.test/pay/${sessionSeq}`,
        connectedAccountId: input.connectedAccountId,
        amountCents: input.amountCents,
        currency: input.currency,
        invoiceId: input.invoiceId,
        businessId: input.businessId,
      };
      checkouts.push(result);
      return result;
    },
    parseCheckoutPaymentEvent,
  };
}

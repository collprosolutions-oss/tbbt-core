import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { getAppUrl } from "@/lib/mail";
import { invoiceNumberFromId } from "@/lib/invoice-document";
import { isStripePlatformConfigured } from "@/lib/payments/config";
import { invoiceAmountToCents, invoiceDueCents } from "@/lib/payments/money";
import { getPaymentProvider } from "@/lib/payments/provider";
import { writeSettingsAuditLog } from "@/lib/settings-ops";
import type {
  BusinessPaymentStatus,
  CheckoutSessionResult,
  PaymentProvider,
  VerifiedCheckoutPayment,
} from "@/lib/payments/types";

type PaymentsClient = PrismaClient | Prisma.TransactionClient;

export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentError";
  }
}

export function paymentErrorMessage(error: unknown, fallback: string) {
  if (error instanceof PaymentError) {
    return error.message;
  }
  return fallback;
}

export function shouldShowPayInvoice(input: {
  invoiceStatus: string;
  amountDueCents: number;
  paymentReady: boolean;
}): boolean {
  return (
    input.invoiceStatus === "SENT" &&
    input.amountDueCents > 0 &&
    input.paymentReady
  );
}

export async function getBusinessPaymentStatus(
  db: PaymentsClient,
  businessId: string,
  provider: PaymentProvider = getPaymentProvider(),
): Promise<BusinessPaymentStatus> {
  const account = await db.businessPaymentAccount.findUnique({
    where: { businessId },
    select: { stripeAccountId: true, provider: true },
  });

  if (!account) {
    return {
      providerLabel: "Stripe",
      status: "not_connected",
      platformConfigured: isStripePlatformConfigured(),
      stripeAccountId: null,
      paymentReady: false,
    };
  }

  try {
    const readiness = await provider.getAccountReadiness(account.stripeAccountId);
    const paymentReady = readiness.chargesEnabled;
    return {
      providerLabel: "Stripe",
      status: paymentReady ? "connected" : "setup_required",
      platformConfigured: isStripePlatformConfigured(),
      stripeAccountId: account.stripeAccountId,
      paymentReady,
    };
  } catch {
    return {
      providerLabel: "Stripe",
      status: "setup_required",
      platformConfigured: isStripePlatformConfigured(),
      stripeAccountId: account.stripeAccountId,
      paymentReady: false,
    };
  }
}

export async function startStripeConnectOnboarding(
  db: PrismaClient,
  access: BusinessAccess,
  input: { appUrl?: string | null } = {},
  provider: PaymentProvider = getPaymentProvider(),
): Promise<{ url: string }> {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);

  const appUrl = input.appUrl ?? getAppUrl();
  if (!appUrl) {
    throw new PaymentError("App URL is not configured.");
  }

  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: {
      id: true,
      name: true,
      paymentAccount: { select: { stripeAccountId: true } },
    },
  });
  if (!business) {
    throw new PaymentError("Business was not found.");
  }

  let stripeAccountId = business.paymentAccount?.stripeAccountId ?? null;
  if (!stripeAccountId) {
    const owner = await db.membership.findFirst({
      where: { businessId: access.businessId, role: "OWNER", active: true },
      select: { user: { select: { email: true } } },
      orderBy: { createdAt: "asc" },
    });
    const created = await provider.createConnectedAccount({
      businessId: access.businessId,
      displayName: business.name,
      contactEmail: owner?.user.email ?? null,
    });
    await db.businessPaymentAccount.create({
      data: {
        businessId: access.businessId,
        provider: provider.id,
        stripeAccountId: created.accountId,
      },
    });
    await writeSettingsAuditLog(db, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "payments",
      settingKey: "stripeAccountId",
      previousValue: null,
      newValue: created.accountId,
    });
    stripeAccountId = created.accountId;
  }

  const link = await provider.createAccountOnboardingLink({
    accountId: stripeAccountId,
    returnUrl: `${appUrl}/settings?section=estimates-payments`,
    refreshUrl: `${appUrl}/settings/stripe/refresh`,
  });
  return { url: link.url };
}

export async function createCustomerInvoiceCheckout(
  db: PaymentsClient,
  token: string,
  provider: PaymentProvider = getPaymentProvider(),
  options: { appUrl?: string | null } = {},
): Promise<CheckoutSessionResult> {
  const appUrl = options.appUrl ?? getAppUrl();
  if (!appUrl) {
    throw new PaymentError("App URL is not configured.");
  }

  const job = token
    ? await db.job.findUnique({
        where: { projectToken: token },
        select: {
          id: true,
          businessId: true,
          invoices: {
            take: 1,
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              businessId: true,
              status: true,
              total: true,
            },
          },
        },
      })
    : null;

  const invoice = job?.invoices[0] ?? null;
  if (!job || !invoice || invoice.businessId !== job.businessId) {
    throw new PaymentError("This invoice is not available.");
  }

  const payment = await getBusinessPaymentStatus(db, job.businessId, provider);
  const amountCents = invoiceDueCents(invoice.status, invoice.total);
  if (
    !shouldShowPayInvoice({
      invoiceStatus: invoice.status,
      amountDueCents: amountCents,
      paymentReady: payment.paymentReady,
    }) ||
    !payment.stripeAccountId
  ) {
    throw new PaymentError("This invoice cannot be paid online right now.");
  }

  return provider.createInvoiceCheckoutSession({
    connectedAccountId: payment.stripeAccountId,
    invoiceId: invoice.id,
    businessId: job.businessId,
    amountCents,
    currency: "usd",
    description: `Invoice ${invoiceNumberFromId(invoice.id)}`,
    successUrl: `${appUrl}/p/${token}?checkout=return`,
    cancelUrl: `${appUrl}/p/${token}?checkout=cancelled`,
  });
}

export async function applyVerifiedCheckoutPayment(
  db: PaymentsClient,
  payment: VerifiedCheckoutPayment,
): Promise<{ applied: boolean; reason: string }> {
  const invoice = await db.invoice.findFirst({
    where: { id: payment.invoiceId },
    select: {
      id: true,
      businessId: true,
      status: true,
      total: true,
    },
  });

  if (!invoice) {
    return { applied: false, reason: "invoice_not_found" };
  }
  if (invoice.businessId !== payment.businessId) {
    return { applied: false, reason: "business_mismatch" };
  }

  const account = await db.businessPaymentAccount.findUnique({
    where: { businessId: invoice.businessId },
    select: { stripeAccountId: true },
  });
  if (!account || account.stripeAccountId !== payment.connectedAccountId) {
    return { applied: false, reason: "account_mismatch" };
  }

  if (payment.currency.toLowerCase() !== "usd") {
    return { applied: false, reason: "currency_mismatch" };
  }

  const expectedCents = invoiceAmountToCents(invoice.total);
  if (payment.amountCents !== expectedCents) {
    return { applied: false, reason: "amount_mismatch" };
  }

  if (invoice.status === "PAID") {
    return { applied: false, reason: "already_paid" };
  }
  if (invoice.status !== "SENT") {
    return { applied: false, reason: "not_sent" };
  }

  const updated = await db.invoice.updateMany({
    where: {
      id: invoice.id,
      businessId: invoice.businessId,
      status: "SENT",
    },
    data: {
      status: "PAID",
      paidAt: new Date(),
      paymentMethod: "STRIPE",
      paymentReference: payment.paymentReference,
    },
  });

  if (updated.count !== 1) {
    return { applied: false, reason: "already_paid" };
  }
  return { applied: true, reason: "paid" };
}

import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { getAppUrl } from "@/lib/mail";
import { invoiceNumberFromId } from "@/lib/invoice-document";
import { isStripePlatformConfigured } from "@/lib/payments/config";
import { invoiceAmountToCents } from "@/lib/payments/money";
import { getPaymentProvider } from "@/lib/payments/provider";
import { safeRetrieveErrorName } from "@/lib/payments/readiness";
import {
  PAYMENT_PURPOSE_INVOICE_BALANCE,
  PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
  invoicePaymentBreakdown,
  listProjectPayments,
  recordSucceededPayment,
  requiredDepositFromLines,
} from "@/lib/project-payments";
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

export function shouldShowPayDeposit(input: {
  requiredCents: number;
  remainingCents: number;
  paymentReady: boolean;
  hasCustomerInvoice: boolean;
}): boolean {
  return (
    input.requiredCents > 0 &&
    input.remainingCents > 0 &&
    input.paymentReady &&
    !input.hasCustomerInvoice
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
      readinessDebug: readiness.debug,
    };
  } catch (error) {
    return {
      providerLabel: "Stripe",
      status: "setup_required",
      platformConfigured: isStripePlatformConfigured(),
      stripeAccountId: account.stripeAccountId,
      paymentReady: false,
      readinessDebug: {
        branch: "retrieve_failed",
        ready: false,
        cardPaymentsStatus: null,
        cardPaymentsStatusDetails: [],
        currentlyDueKeys: [],
        pastDueKeys: [],
        pendingVerificationKeys: [],
        chargesEnabled: null,
        detailsSubmitted: null,
        disabledReason: null,
        retrieveError: safeRetrieveErrorName(error),
      },
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

function centsToDecimal(cents: number) {
  return new Prisma.Decimal(cents).div(100);
}

async function loadInvoicePaymentBreakdown(
  db: PaymentsClient,
  invoice: { id: string; businessId: string; status: string; total: Prisma.Decimal },
) {
  const payments = await listProjectPayments(db, {
    businessId: invoice.businessId,
    invoiceId: invoice.id,
  });
  return invoicePaymentBreakdown({
    status: invoice.status,
    total: invoice.total,
    payments,
  });
}

async function maybeMarkInvoicePaid(
  db: PaymentsClient,
  invoice: { id: string; businessId: string; status: string },
  paymentReference: string,
) {
  if (invoice.status === "PAID") return;
  const current = await db.invoice.findFirst({
    where: { id: invoice.id, businessId: invoice.businessId },
    select: { id: true, businessId: true, status: true, total: true },
  });
  if (!current || current.status === "PAID") return;
  const breakdown = await loadInvoicePaymentBreakdown(db, current);
  if (breakdown.amountDue.gt(0)) return;
  await db.invoice.updateMany({
    where: {
      id: current.id,
      businessId: current.businessId,
      status: { in: ["SENT", "DRAFT"] },
    },
    data: {
      status: "PAID",
      paidAt: new Date(),
      paymentMethod: "STRIPE",
      paymentReference,
    },
  });
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
  const breakdown = await loadInvoicePaymentBreakdown(db, invoice);
  const amountCents = invoiceAmountToCents(breakdown.amountDue);
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
    successUrl: `${appUrl}/p/${token}?checkout=return&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${appUrl}/p/${token}?checkout=cancelled`,
  });
}

export async function applyVerifiedCheckoutPayment(
  db: PaymentsClient,
  payment: VerifiedCheckoutPayment,
): Promise<{ applied: boolean; reason: string }> {
  if (payment.currency.toLowerCase() !== "usd") {
    return { applied: false, reason: "currency_mismatch" };
  }
  if (payment.purpose === "material_deposit") {
    return applyVerifiedDepositPayment(db, payment);
  }
  return applyVerifiedInvoicePayment(db, payment);
}

async function applyVerifiedInvoicePayment(
  db: PaymentsClient,
  payment: VerifiedCheckoutPayment,
): Promise<{ applied: boolean; reason: string }> {
  if (!payment.invoiceId) {
    return { applied: false, reason: "invoice_not_found" };
  }
  const invoice = await db.invoice.findFirst({
    where: { id: payment.invoiceId },
    select: {
      id: true,
      businessId: true,
      status: true,
      total: true,
      jobId: true,
      customerId: true,
      job: { select: { estimateId: true } },
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

  const breakdown = await loadInvoicePaymentBreakdown(db, invoice);
  if (invoice.status === "PAID" || breakdown.amountDue.lte(0)) {
    return { applied: false, reason: "already_paid" };
  }
  if (invoice.status !== "SENT") {
    return { applied: false, reason: "not_sent" };
  }
  const expectedCents = invoiceAmountToCents(breakdown.amountDue);
  if (payment.amountCents !== expectedCents) {
    return { applied: false, reason: "amount_mismatch" };
  }

  const recorded = await recordSucceededPayment(db, {
    businessId: invoice.businessId,
    customerId: invoice.customerId,
    estimateId: invoice.job?.estimateId ?? null,
    jobId: invoice.jobId,
    invoiceId: invoice.id,
    purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
    amount: centsToDecimal(payment.amountCents),
    method: "STRIPE",
    stripeCheckoutSessionId: payment.checkoutSessionId,
    stripePaymentIntentId: payment.paymentReference.startsWith("pi_")
      ? payment.paymentReference
      : null,
  });
  if (!recorded.created) {
    return { applied: false, reason: "already_paid" };
  }
  await maybeMarkInvoicePaid(db, invoice, payment.paymentReference);
  return { applied: true, reason: "paid" };
}

async function applyVerifiedDepositPayment(
  db: PaymentsClient,
  payment: VerifiedCheckoutPayment,
): Promise<{ applied: boolean; reason: string }> {
  if (!payment.estimateId) {
    return { applied: false, reason: "estimate_not_found" };
  }
  const estimate = await db.estimate.findFirst({
    where: { id: payment.estimateId },
    select: {
      id: true,
      businessId: true,
      customerId: true,
      status: true,
      total: true,
      jobs: {
        select: { id: true, invoices: { select: { id: true }, take: 1, orderBy: { createdAt: "asc" } } },
        take: 1,
      },
    },
  });
  if (!estimate) {
    return { applied: false, reason: "estimate_not_found" };
  }
  if (estimate.businessId !== payment.businessId) {
    return { applied: false, reason: "business_mismatch" };
  }
  if (estimate.status !== "APPROVED") {
    return { applied: false, reason: "not_approved" };
  }

  const account = await db.businessPaymentAccount.findUnique({
    where: { businessId: estimate.businessId },
    select: { stripeAccountId: true },
  });
  if (!account || account.stripeAccountId !== payment.connectedAccountId) {
    return { applied: false, reason: "account_mismatch" };
  }

  const job = estimate.jobs[0] ?? null;
  const invoiceId = job?.invoices[0]?.id ?? null;
  const recorded = await recordSucceededPayment(db, {
    businessId: estimate.businessId,
    customerId: estimate.customerId,
    estimateId: estimate.id,
    jobId: job?.id ?? null,
    invoiceId,
    purpose: PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
    amount: centsToDecimal(payment.amountCents),
    method: "STRIPE",
    stripeCheckoutSessionId: payment.checkoutSessionId,
    stripePaymentIntentId: payment.paymentReference.startsWith("pi_")
      ? payment.paymentReference
      : null,
  });
  if (!recorded.created) {
    return { applied: false, reason: "already_paid" };
  }
  if (invoiceId) {
    const invoice = await db.invoice.findFirst({
      where: { id: invoiceId, businessId: estimate.businessId },
      select: { id: true, businessId: true, status: true },
    });
    if (invoice) {
      await maybeMarkInvoicePaid(db, invoice, payment.paymentReference);
    }
  }
  return { applied: true, reason: "paid" };
}

const DEPOSIT_ESTIMATE_SELECT = {
  id: true,
  businessId: true,
  status: true,
  total: true,
  approvedVersion: {
    select: {
      total: true,
      lineItems: { select: { type: true, total: true, description: true } },
    },
  },
  lineItems: { select: { type: true, total: true, description: true } },
} as const;

async function loadDepositEstimateByCustomerToken(
  db: PaymentsClient,
  token: string,
) {
  if (!token) return null;
  const estimate = await db.estimate.findUnique({
    where: { publicToken: token },
    select: DEPOSIT_ESTIMATE_SELECT,
  });
  if (estimate) {
    return { estimate, returnPath: `/e/${token}` as const };
  }
  const job = await db.job.findUnique({
    where: { projectToken: token },
    select: { estimate: { select: DEPOSIT_ESTIMATE_SELECT } },
  });
  if (job?.estimate) {
    return { estimate: job.estimate, returnPath: `/p/${token}` as const };
  }
  return null;
}

export async function createCustomerDepositCheckout(
  db: PaymentsClient,
  token: string,
  provider: PaymentProvider = getPaymentProvider(),
  options: { appUrl?: string | null } = {},
): Promise<CheckoutSessionResult> {
  const appUrl = options.appUrl ?? getAppUrl();
  if (!appUrl) {
    throw new PaymentError("App URL is not configured.");
  }
  const loaded = await loadDepositEstimateByCustomerToken(db, token);
  if (!loaded || loaded.estimate.status !== "APPROVED") {
    throw new PaymentError("This deposit cannot be paid yet.");
  }
  const estimate = loaded.estimate;
  const lines = estimate.approvedVersion?.lineItems ?? estimate.lineItems;
  const total = estimate.approvedVersion?.total ?? estimate.total;
  const required = requiredDepositFromLines(lines, total);
  const payments = await listProjectPayments(db, {
    businessId: estimate.businessId,
    estimateId: estimate.id,
  });
  const paid = payments
    .filter((row) => row.purpose === PAYMENT_PURPOSE_MATERIAL_DEPOSIT)
    .reduce((sum, row) => sum.add(row.amount), new Prisma.Decimal(0));
  const due = required.sub(paid);
  if (due.lte(0)) {
    throw new PaymentError("This material deposit is already paid.");
  }
  const payment = await getBusinessPaymentStatus(db, estimate.businessId, provider);
  if (!payment.paymentReady || !payment.stripeAccountId) {
    throw new PaymentError("Online deposit payment is not available right now.");
  }
  return provider.createDepositCheckoutSession({
    connectedAccountId: payment.stripeAccountId,
    estimateId: estimate.id,
    businessId: estimate.businessId,
    amountCents: invoiceAmountToCents(due),
    currency: "usd",
    description: "Material deposit",
    successUrl: `${appUrl}${loaded.returnPath}?checkout=return&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${appUrl}${loaded.returnPath}?checkout=cancelled`,
  });
}

export async function reconcileEstimateDepositCheckout(
  db: PaymentsClient,
  token: string,
  checkoutSessionId?: string | null,
  provider: PaymentProvider = getPaymentProvider(),
): Promise<ReconcileCheckoutResult> {
  const loaded = await loadDepositEstimateByCustomerToken(db, token);
  const estimate = loaded?.estimate ?? null;
  if (!estimate) {
    return { applied: false, reason: "estimate_not_found" };
  }
  if (estimate.status !== "APPROVED") {
    return { applied: false, reason: "not_approved" };
  }
  const account = await db.businessPaymentAccount.findUnique({
    where: { businessId: estimate.businessId },
    select: { stripeAccountId: true },
  });
  if (!account) {
    return { applied: false, reason: "no_payment_account" };
  }
  const lines = estimate.approvedVersion?.lineItems ?? estimate.lineItems;
  const total = estimate.approvedVersion?.total ?? estimate.total;
  const required = requiredDepositFromLines(lines, total);
  const payments = await listProjectPayments(db, {
    businessId: estimate.businessId,
    estimateId: estimate.id,
  });
  const paid = payments
    .filter((row) => row.purpose === PAYMENT_PURPOSE_MATERIAL_DEPOSIT)
    .reduce((sum, row) => sum.add(row.amount), new Prisma.Decimal(0));
  const due = required.sub(paid);
  if (due.lte(0)) {
    return { applied: false, reason: "already_paid" };
  }
  let payment: VerifiedCheckoutPayment | null = null;
  try {
    payment = await provider.findPaidDepositCheckout({
      connectedAccountId: account.stripeAccountId,
      estimateId: estimate.id,
      businessId: estimate.businessId,
      amountCents: invoiceAmountToCents(due),
      checkoutSessionId,
    });
  } catch {
    return { applied: false, reason: "lookup_failed" };
  }
  if (!payment) {
    return { applied: false, reason: "no_paid_checkout" };
  }
  return applyVerifiedCheckoutPayment(db, payment);
}

export type ReconcileCheckoutResult = {
  applied: boolean;
  reason: string;
};

/**
 * Outbound Stripe API lookup for a Checkout Session that already succeeded.
 * Used when inbound webhooks never reached TBBT (Preview Vercel Authentication)
 * and when the owner or customer refreshes after a completed payment.
 * Never marks paid from a browser query flag alone.
 */
export async function reconcileStripeCheckoutPayment(
  db: PaymentsClient,
  businessId: string,
  invoiceId: string,
  checkoutSessionId?: string | null,
  provider: PaymentProvider = getPaymentProvider(),
): Promise<ReconcileCheckoutResult> {
  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, businessId },
    select: { id: true, status: true, total: true },
  });
  if (!invoice) {
    return { applied: false, reason: "invoice_not_found" };
  }
  if (invoice.status === "PAID") {
    return { applied: false, reason: "already_paid" };
  }
  if (invoice.status !== "SENT") {
    return { applied: false, reason: "invoice_not_sent" };
  }

  const account = await db.businessPaymentAccount.findUnique({
    where: { businessId },
    select: { stripeAccountId: true },
  });
  if (!account) {
    return { applied: false, reason: "no_payment_account" };
  }

  let payment: VerifiedCheckoutPayment | null = null;
  try {
    const breakdown = await loadInvoicePaymentBreakdown(db, {
      id: invoice.id,
      businessId,
      status: invoice.status,
      total: invoice.total,
    });
    payment = await provider.findPaidInvoiceCheckout({
      connectedAccountId: account.stripeAccountId,
      invoiceId: invoice.id,
      businessId,
      amountCents: invoiceAmountToCents(breakdown.amountDue),
      checkoutSessionId,
    });
  } catch {
    return { applied: false, reason: "lookup_failed" };
  }
  if (!payment) {
    return { applied: false, reason: "no_paid_checkout" };
  }

  return applyVerifiedCheckoutPayment(db, payment);
}

/**
 * Token-scoped reconcile for the customer portal. Resolves the business and
 * invoice from Job.projectToken so portal routes never take a client
 * businessId.
 */
export async function reconcileProjectTokenCheckoutPayment(
  db: PaymentsClient,
  token: string,
  checkoutSessionId?: string | null,
  provider: PaymentProvider = getPaymentProvider(),
): Promise<ReconcileCheckoutResult> {
  const job = token
    ? await db.job.findUnique({
        where: { projectToken: token },
        select: {
          businessId: true,
          invoices: {
            take: 1,
            orderBy: { createdAt: "asc" },
            select: { id: true },
          },
        },
      })
    : null;
  const invoice = job?.invoices[0] ?? null;
  if (!job || !invoice) {
    return { applied: false, reason: "invoice_not_found" };
  }
  return reconcileStripeCheckoutPayment(
    db,
    job.businessId,
    invoice.id,
    checkoutSessionId,
    provider,
  );
}

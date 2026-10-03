import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { getAppUrl } from "@/lib/mail";
import { getTenantAppOrigin } from "@/lib/tenant-app-url";
import { invoiceNumberFromId } from "@/lib/invoice-document";
import { isStripePlatformConfigured } from "@/lib/payments/config";
import { invoiceAmountToCents } from "@/lib/payments/money";
import { getPaymentProvider } from "@/lib/payments/provider";
import { safeRetrieveErrorName } from "@/lib/payments/readiness";
import {
  PAYMENT_PURPOSE_INVOICE_BALANCE,
  PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
  invoicePaymentBreakdown,
  invoiceRemainingReadTestHooks,
  listPaymentsForInvoice,
  listProjectPayments,
  recordSucceededPayment,
  requiredDepositFromLines,
} from "@/lib/project-payments";
import { findLiveJobByProjectToken } from "@/lib/project-link-data";
import { selectPortalInvoice } from "@/lib/revenue-integrity";
import { ensureInvoiceCreditTable } from "@/lib/invoice-credits";
import {
  findInvoiceCheckoutSession,
  recordInvoiceCheckoutSession,
} from "@/lib/payments/checkout-session-record";
import { writeSettingsAuditLog } from "@/lib/settings-ops";
import { resolveChosenCommercialScope } from "@/lib/estimate-options";
import {
  connectedAccountReplacementBlockReason,
  isUnknownConnectedAccountError,
  logStripeConnectOnboardingError,
  stripeConnectOnboardingFailureMessage,
} from "@/lib/payments/stripe-errors";
import type {
  BusinessPaymentStatus,
  CheckoutSessionResult,
  PaymentProvider,
  VerifiedCheckoutPayment,
} from "@/lib/payments/types";

type PaymentsClient = PrismaClient | Prisma.TransactionClient;

export const STRIPE_CREDIT_MISMATCH_REVIEW_NOTE = "STRIPE_CREDIT_MISMATCH_REVIEW";
export const STRIPE_CREDIT_MISMATCH_REASON = "credit_amount_mismatch_review";
export const STRIPE_CREDIT_MISMATCH_OWNER_TITLE = "Stripe charge after recorded credit";
export const STRIPE_CREDIT_MISMATCH_OWNER_DETAIL =
  "A customer card charge no longer matches remaining due because a credit was recorded. Review this invoice and refund in Stripe if needed. TBBT does not refund automatically and does not message the customer.";

export function isStripeCreditMismatchReviewNote(note: string | null | undefined) {
  return Boolean(note?.startsWith(STRIPE_CREDIT_MISMATCH_REVIEW_NOTE));
}

export function paymentsNeedingStripeCreditMismatchReview<
  T extends { note?: string | null; stripeCreditMismatchResolvedAt?: Date | null },
>(payments: readonly T[]): T[] {
  // STRIPE_CREDIT_MISMATCH_OWNER_REVIEW
  return payments.filter(
    (payment) =>
      isStripeCreditMismatchReviewNote(payment.note) && !payment.stripeCreditMismatchResolvedAt,
  );
}

export function stripeCreditMismatchDashboardWhere(businessId: string) {
  // STRIPE_CREDIT_MISMATCH_DASHBOARD_UNRESOLVED
  return {
    businessId,
    note: { startsWith: STRIPE_CREDIT_MISMATCH_REVIEW_NOTE },
    stripeCreditMismatchResolvedAt: null,
  };
}

export async function listOpenStripeCreditMismatchReviews(
  db: PaymentsClient,
  businessId: string,
  take?: number,
) {
  return db.payment.findMany({
    where: stripeCreditMismatchDashboardWhere(businessId),
    select: {
      id: true,
      amount: true,
      invoiceId: true,
      note: true,
      stripeCreditMismatchResolvedAt: true,
      invoice: { select: { id: true, customer: { select: { name: true } } } },
    },
    orderBy: { createdAt: "desc" },
    ...(take ? { take } : {}),
  });
}

/** Checkout could have been created for remaining due before later credits: total − payments. */
export function staleCheckoutBoundCents(
  invoiceTotal: Prisma.Decimal | number | string,
  amountPaid: Prisma.Decimal | number | string,
) {
  return invoiceAmountToCents(new Prisma.Decimal(invoiceTotal.toString()).sub(amountPaid.toString()));
}

const ZERO_MONEY = new Prisma.Decimal(0);

export function historicalRemainingDueCents(input: {
  invoiceTotal: Prisma.Decimal | number | string;
  payments: readonly { amount: Prisma.Decimal | number | string; receivedAt: Date }[];
  credits: readonly { amount: Prisma.Decimal | number | string; createdAt: Date }[];
}): number[] {
  const total = new Prisma.Decimal(input.invoiceTotal.toString());
  const credits = [...input.credits].sort((left, right) => {
    const delta = left.createdAt.getTime() - right.createdAt.getTime();
    return delta !== 0 ? delta : 0;
  });
  const amounts = new Set<number>();
  if (total.gt(0)) {
    amounts.add(invoiceAmountToCents(total));
  }
  for (let k = 0; k <= credits.length; k += 1) {
    const creditSum = credits
      .slice(0, k)
      .reduce((sum, credit) => sum.add(credit.amount.toString()), ZERO_MONEY);
    const cutoff = k === 0 ? credits[0]?.createdAt : credits[k - 1]?.createdAt;
    const paymentSum = input.payments.reduce((sum, payment) => {
      if (cutoff && ((k === 0 && payment.receivedAt >= cutoff) || (k > 0 && payment.receivedAt > cutoff))) {
        return sum;
      }
      return sum.add(payment.amount.toString());
    }, ZERO_MONEY);
    const remaining = total.sub(paymentSum).sub(creditSum);
    if (remaining.gt(0)) {
      amounts.add(invoiceAmountToCents(remaining));
    }
  }
  return [...amounts];
}

type InvoiceBalanceTarget = {
  id: string;
  businessId: string;
  status: string;
  total: Prisma.Decimal;
  jobId?: string | null;
  kind?: string | null;
};

function isPrismaClient(db: PaymentsClient): db is PrismaClient {
  return typeof (db as PrismaClient).$transaction === "function";
}

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
  appUrlConfigured: boolean;
}): boolean {
  return (
    input.invoiceStatus === "SENT" &&
    input.amountDueCents > 0 &&
    input.paymentReady &&
    input.appUrlConfigured
  );
}

export function shouldShowPayDeposit(input: {
  requiredCents: number;
  remainingCents: number;
  paymentReady: boolean;
  appUrlConfigured: boolean;
  hasCustomerInvoice: boolean;
}): boolean {
  return (
    input.requiredCents > 0 &&
    input.remainingCents > 0 &&
    input.paymentReady &&
    input.appUrlConfigured &&
    !input.hasCustomerInvoice
  );
}

function withCheckoutReadiness(
  status: Omit<BusinessPaymentStatus, "appUrlConfigured" | "onlineCheckoutPossible">,
): BusinessPaymentStatus {
  const appUrlConfigured = Boolean(getAppUrl());
  return {
    ...status,
    appUrlConfigured,
    onlineCheckoutPossible: status.paymentReady && appUrlConfigured,
  };
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
    return withCheckoutReadiness({
      providerLabel: "Stripe",
      status: "not_connected",
      platformConfigured: isStripePlatformConfigured(),
      stripeAccountId: null,
      paymentReady: false,
    });
  }

  try {
    const readiness = await provider.getAccountReadiness(account.stripeAccountId);
    const paymentReady = readiness.chargesEnabled;
    return withCheckoutReadiness({
      providerLabel: "Stripe",
      status: paymentReady ? "connected" : "setup_required",
      platformConfigured: isStripePlatformConfigured(),
      stripeAccountId: account.stripeAccountId,
      paymentReady,
      readinessDebug: readiness.debug,
    });
  } catch (error) {
    return withCheckoutReadiness({
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
    });
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
    stripeAccountId = await createBusinessConnectedAccount(db, access, business, provider);
  }

  const returnUrl = `${appUrl}/settings?section=estimates-payments`;
  const refreshUrl = `${appUrl}/settings/stripe/refresh`;
  try {
    const link = await provider.createAccountOnboardingLink({
      accountId: stripeAccountId,
      returnUrl,
      refreshUrl,
    });
    return { url: link.url };
  } catch (error) {
    logStripeConnectOnboardingError(error);
    if (!isUnknownConnectedAccountError(error)) {
      throw new PaymentError(stripeConnectOnboardingFailureMessage(error));
    }
    const stripePayments = await db.payment.findMany({
      where: { businessId: access.businessId, method: "STRIPE" },
      select: { stripeCheckoutSessionId: true },
    });
    const replacementBlock = connectedAccountReplacementBlockReason(stripePayments);
    if (replacementBlock === "live") {
      throw new PaymentError(
        "This business's Stripe account could not be loaded on the current platform. Do not create a second connected account while live Stripe payments already exist.",
      );
    }
    if (replacementBlock === "unknown") {
      throw new PaymentError(
        "This business's Stripe account could not be loaded on the current platform. Do not create a second connected account while Stripe payment history cannot be confirmed as test-mode.",
      );
    }
    const previousAccountId = stripeAccountId;
    stripeAccountId = await createBusinessConnectedAccount(db, access, business, provider, {
      replaceAccountId: previousAccountId,
    });
    try {
      const link = await provider.createAccountOnboardingLink({
        accountId: stripeAccountId,
        returnUrl,
        refreshUrl,
      });
      return { url: link.url };
    } catch (retryError) {
      logStripeConnectOnboardingError(retryError);
      throw new PaymentError(stripeConnectOnboardingFailureMessage(retryError));
    }
  }
}

async function createBusinessConnectedAccount(
  db: PrismaClient,
  access: BusinessAccess,
  business: { id: string; name: string; paymentAccount: { stripeAccountId: string } | null },
  provider: PaymentProvider,
  options: { replaceAccountId?: string | null } = {},
) {
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
  if (options.replaceAccountId) {
    await db.businessPaymentAccount.update({
      where: { businessId: access.businessId },
      data: {
        provider: provider.id,
        stripeAccountId: created.accountId,
      },
    });
  } else {
    await db.businessPaymentAccount.create({
      data: {
        businessId: access.businessId,
        provider: provider.id,
        stripeAccountId: created.accountId,
      },
    });
  }
  await writeSettingsAuditLog(db, {
    businessId: access.businessId,
    changedByMembershipId: access.workspace.membership.id,
    settingArea: "payments",
    settingKey: "stripeAccountId",
    previousValue: options.replaceAccountId ?? null,
    newValue: created.accountId,
  });
  return created.accountId;
}

function centsToDecimal(cents: number) {
  return new Prisma.Decimal(cents).div(100);
}

async function loadInvoicePaymentBreakdown(
  db: PaymentsClient,
  invoice: InvoiceBalanceTarget,
) {
  await ensureInvoiceCreditTable(db);
  const [payments, credits] = await Promise.all([
    listPaymentsForInvoice(db, {
      businessId: invoice.businessId,
      invoice: {
        id: invoice.id,
        jobId: invoice.jobId ?? null,
        kind: invoice.kind ?? "ORIGINAL",
      },
    }),
    db.invoiceCredit.findMany({
      where: { businessId: invoice.businessId, invoiceId: invoice.id },
      select: { id: true, amount: true, recordedByMembershipId: true, createdAt: true },
    }),
  ]);
  return {
    payments,
    credits,
    breakdown: invoicePaymentBreakdown({
      status: invoice.status,
      total: invoice.total,
      payments,
      credits,
    }),
  };
}

async function maybeMarkInvoicePaid(
  db: PaymentsClient,
  invoice: { id: string; businessId: string; status: string },
  paymentReference: string,
) {
  if (invoice.status === "PAID") return;
  const current = await db.invoice.findFirst({
    where: { id: invoice.id, businessId: invoice.businessId },
    select: { id: true, businessId: true, status: true, total: true, jobId: true, kind: true },
  });
  if (!current || current.status === "PAID") return;
  const { breakdown } = await loadInvoicePaymentBreakdown(db, current);
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

/**
 * Customer checkout uses remaining due after payments and recorded
 * credits. The expected cents are stored on the Checkout session
 * metadata and in InvoiceCheckoutSession. Open Checkout sessions do not block OWNER credits.
 * A later webhook is accepted when it equals
 * that stored session amount, or — for sessions created before the
 * store existed — a historical remaining-due amount (total minus
 * payments that existed then minus the first k credits). Excess over
 * current net due is recorded and flagged for owner review. Unbounded
 * amounts are amount_mismatch. VOID invoices keep VOID and still flag
 * a matching charge.
 */
export async function createCustomerInvoiceCheckout(
  db: PaymentsClient,
  token: string,
  provider: PaymentProvider = getPaymentProvider(),
  options: { appUrl?: string | null } = {},
): Promise<CheckoutSessionResult> {
  const job = token
    ? await findLiveJobByProjectToken(db, token, {
        id: true,
        businessId: true,
        business: { select: { slug: true } },
        invoices: {
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: {
              id: true,
              businessId: true,
              status: true,
              total: true,
              jobId: true,
              kind: true,
              createdAt: true,
            },
          },
      })
    : null;

  const invoice = selectPortalInvoice(job?.invoices ?? []);
  if (!job || !invoice || invoice.businessId !== job.businessId) {
    throw new PaymentError("This invoice is not available.");
  }

  const appUrl = options.appUrl ?? getTenantAppOrigin(job.business.slug) ?? getAppUrl();
  if (!appUrl) {
    throw new PaymentError("App URL is not configured.");
  }

  const payment = await getBusinessPaymentStatus(db, job.businessId, provider);
  const { breakdown } = await loadInvoicePaymentBreakdown(db, {
    ...invoice,
    jobId: job.id,
  });
  const amountCents = invoiceAmountToCents(breakdown.amountDue);
  if (
    !shouldShowPayInvoice({
      invoiceStatus: invoice.status,
      amountDueCents: amountCents,
      paymentReady: payment.paymentReady,
      appUrlConfigured: Boolean(appUrl),
    }) ||
    !payment.stripeAccountId
  ) {
    throw new PaymentError("This invoice cannot be paid online right now.");
  }

  const session = await provider.createInvoiceCheckoutSession({
    connectedAccountId: payment.stripeAccountId,
    invoiceId: invoice.id,
    businessId: job.businessId,
    amountCents,
    currency: "usd",
    description: `Invoice ${invoiceNumberFromId(invoice.id)}`,
    successUrl: `${appUrl}/p/${token}?checkout=return&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${appUrl}/p/${token}?checkout=cancelled`,
  });
  await recordInvoiceCheckoutSession(db, {
    businessId: job.businessId,
    invoiceId: invoice.id,
    stripeSessionId: session.id,
    amountCents,
  });
  return session;
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
  const invoiceId = payment.invoiceId;
  if (!invoiceId) {
    return { applied: false, reason: "invoice_not_found" };
  }

  const applyLocked = async (tx: Prisma.TransactionClient) => {
    const claimed = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, businessId: true },
    });
    if (!claimed) {
      return { applied: false, reason: "invoice_not_found" };
    }
    if (claimed.businessId !== payment.businessId) {
      return { applied: false, reason: "business_mismatch" };
    }

    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "Invoice"
      WHERE id = ${invoiceId} AND "businessId" = ${payment.businessId}
      FOR UPDATE
    `;
    if (locked.length === 0) {
      return { applied: false, reason: "invoice_not_found" };
    }

    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, businessId: payment.businessId },
      select: {
        id: true,
        businessId: true,
        status: true,
        total: true,
        jobId: true,
        kind: true,
        customerId: true,
        job: { select: { estimateId: true } },
      },
    });

    if (!invoice) {
      return { applied: false, reason: "invoice_not_found" };
    }

    const account = await tx.businessPaymentAccount.findUnique({
      where: { businessId: invoice.businessId },
      select: { stripeAccountId: true },
    });
    if (!account || account.stripeAccountId !== payment.connectedAccountId) {
      return { applied: false, reason: "account_mismatch" };
    }

    const { breakdown, credits, payments } = await loadInvoicePaymentBreakdown(tx, invoice);
    const expectedCents =
      breakdown.amountDue.gt(0) && invoice.status === "SENT"
        ? invoiceAmountToCents(breakdown.amountDue)
        : 0;
    const storedSession = await findInvoiceCheckoutSession(tx, payment.checkoutSessionId);
    const storedMatch = Boolean(
      storedSession &&
        // STORED_SESSION_INVOICE_MATCH
        storedSession.invoiceId === invoice.id &&
        storedSession.businessId === invoice.businessId &&
        // STORED_SESSION_AMOUNT_MATCH
        storedSession.amountCents === payment.amountCents,
    );
    const historicalAmounts = historicalRemainingDueCents({
      invoiceTotal: invoice.total,
      payments,
      credits,
    });
    // STALE_CHECKOUT_AMOUNT_BOUND
    const historyMatch = !storedSession && historicalAmounts.includes(payment.amountCents);
    const exactMatch =
      invoice.status === "SENT" &&
      expectedCents > 0 &&
      payment.amountCents === expectedCents;
    const staleCreditMatch =
      (storedMatch || historyMatch) &&
      payment.amountCents > expectedCents &&
      (credits.length > 0 || invoice.status === "VOID" || invoice.status === "PAID");
    // STALE_CHECKOUT_AFTER_FULL_CREDIT
    if (!exactMatch && !staleCreditMatch) {
      if (invoice.status === "VOID") {
        return { applied: false, reason: "amount_mismatch" };
      }
      if ((invoice.status === "PAID" || breakdown.amountDue.lte(0)) && !credits.length) {
        return { applied: false, reason: "already_paid" };
      }
      if (invoice.status !== "SENT" && invoice.status !== "PAID") {
        return { applied: false, reason: "not_sent" };
      }
      return { applied: false, reason: "amount_mismatch" };
    }
    await invoiceRemainingReadTestHooks.afterRead();

    const reviewNote = staleCreditMatch
      ? `${STRIPE_CREDIT_MISMATCH_REVIEW_NOTE}: charged ${payment.amountCents} cents after recorded credit; remaining was ${breakdown.amountDue.toFixed(2)}`
      : null;
    const recorded = await recordSucceededPayment(tx, {
      businessId: invoice.businessId,
      customerId: invoice.customerId,
      estimateId: invoice.job?.estimateId ?? null,
      jobId: invoice.jobId,
      invoiceId: invoice.id,
      purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
      amount: centsToDecimal(payment.amountCents),
      method: "STRIPE",
      note: reviewNote,
      stripeCheckoutSessionId: payment.checkoutSessionId,
      stripePaymentIntentId: payment.paymentReference.startsWith("pi_")
        ? payment.paymentReference
        : null,
    });
    if (!recorded.created) {
      return { applied: false, reason: "already_paid" };
    }

    if (staleCreditMatch) {
      const actor = credits[credits.length - 1]?.recordedByMembershipId;
      if (actor) {
        await writeSettingsAuditLog(tx, {
          businessId: invoice.businessId,
          changedByMembershipId: actor,
          settingArea: "payments",
          settingKey: "invoiceStripeCreditMismatch",
          previousValue: {
            invoiceId: invoice.id,
            remainingDue: breakdown.amountDue.toString(),
            checkoutSessionId: payment.checkoutSessionId,
          },
          newValue: {
            paymentId: recorded.id,
            chargedCents: payment.amountCents,
            reason: STRIPE_CREDIT_MISMATCH_REASON,
            stripeRefund: false,
            customerMessage: false,
            ownerReview: true,
          },
        });
      }
    }

    await maybeMarkInvoicePaid(tx, invoice, payment.paymentReference);
    return {
      applied: true,
      reason: staleCreditMatch ? STRIPE_CREDIT_MISMATCH_REASON : "paid",
    };
  };

  return isPrismaClient(db) ? db.$transaction(applyLocked) : applyLocked(db);
}

export function stripeCreditMismatchResolveWhere(
  access: { scope: { businessId: string } },
  paymentId: string,
) {
  // RESOLVE_MISMATCH_TENANT_SCOPE
  return { id: paymentId, ...access.scope };
}

export async function resolveStripeCreditMismatchReview(
  db: PaymentsClient,
  access: BusinessAccess,
  paymentId: string,
): Promise<{ resolved: boolean; alreadyResolved: boolean; paymentId: string }> {
  requireBusinessCapability(access, CAPABILITIES.RESOLVE_STRIPE_CREDIT_MISMATCH);
  const payment = access.assertOwned(
    await db.payment.findFirst({
      where: stripeCreditMismatchResolveWhere(access, paymentId),
      select: {
        id: true,
        businessId: true,
        invoiceId: true,
        note: true,
        stripeCreditMismatchResolvedAt: true,
      },
    }),
  );
  if (!isStripeCreditMismatchReviewNote(payment.note)) {
    throw new PaymentError("That payment is not flagged for credit-mismatch review.");
  }
  if (payment.stripeCreditMismatchResolvedAt) {
    return { resolved: true, alreadyResolved: true, paymentId: payment.id };
  }
  await db.payment.updateMany({
    where: {
      id: payment.id,
      businessId: access.businessId,
      stripeCreditMismatchResolvedAt: null,
    },
    data: { stripeCreditMismatchResolvedAt: new Date() },
  });
  await writeSettingsAuditLog(db, {
    businessId: access.businessId,
    changedByMembershipId: access.workspace.membership.id,
    settingArea: "payments",
    settingKey: "invoiceStripeCreditMismatchResolved",
    previousValue: {
      paymentId: payment.id,
      invoiceId: payment.invoiceId,
      ownerReview: true,
    },
    newValue: {
      paymentId: payment.id,
      resolved: true,
      stripeRefund: false,
      customerMessage: false,
    },
  });
  return { resolved: true, alreadyResolved: false, paymentId: payment.id };
}

const DEPOSIT_APPLY_ESTIMATE_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  status: true,
  total: true,
  approvedOptionId: true,
  approvedOption: { select: { id: true, total: true } },
  approvedVersion: {
    select: {
      total: true,
      lineItems: { select: { type: true, total: true, description: true, optionId: true } },
    },
  },
  lineItems: { select: { type: true, total: true, description: true, optionId: true } },
  jobs: {
    select: { id: true, invoices: { select: { id: true }, take: 1, orderBy: { createdAt: "asc" } } },
    take: 1,
  },
} as const;

async function applyVerifiedDepositPayment(
  db: PaymentsClient,
  payment: VerifiedCheckoutPayment,
): Promise<{ applied: boolean; reason: string }> {
  const estimateId = payment.estimateId;
  if (!estimateId) {
    return { applied: false, reason: "estimate_not_found" };
  }

  const applyLocked = async (tx: Prisma.TransactionClient) => {
    const claimed = await tx.estimate.findUnique({
      where: { id: estimateId },
      select: { id: true, businessId: true },
    });
    if (!claimed) {
      return { applied: false, reason: "estimate_not_found" };
    }
    if (claimed.businessId !== payment.businessId) {
      return { applied: false, reason: "business_mismatch" };
    }

    // ESTIMATE_DEPOSIT_FOR_NO_KEY_UPDATE
    // NO KEY so Payment FK inserts (FOR KEY SHARE on Estimate) from the
    // invoice-balance path cannot deadlock against this lock.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "Estimate"
      WHERE id = ${estimateId} AND "businessId" = ${payment.businessId}
      FOR NO KEY UPDATE
    `;
    if (locked.length === 0) {
      return { applied: false, reason: "estimate_not_found" };
    }

    const estimate = await tx.estimate.findFirst({
      where: { id: estimateId, businessId: payment.businessId },
      select: DEPOSIT_APPLY_ESTIMATE_SELECT,
    });
    if (!estimate) {
      return { applied: false, reason: "estimate_not_found" };
    }
    if (estimate.status !== "APPROVED") {
      return { applied: false, reason: "not_approved" };
    }

    const account = await tx.businessPaymentAccount.findUnique({
      where: { businessId: estimate.businessId },
      select: { stripeAccountId: true },
    });
    if (!account || account.stripeAccountId !== payment.connectedAccountId) {
      return { applied: false, reason: "account_mismatch" };
    }

    const chosen = resolveChosenCommercialScope({
      total: estimate.total,
      lineItems: estimate.lineItems,
      approvedOptionId: estimate.approvedOptionId,
      approvedOption: estimate.approvedOption,
      approvedVersion: estimate.approvedVersion,
    });
    const lines = chosen.lineItems;
    const total = chosen.total;
    const required = requiredDepositFromLines(lines, total);
    const existingPayments = await listProjectPayments(tx, {
      businessId: estimate.businessId,
      estimateId: estimate.id,
    });
    const alreadyPaid = existingPayments
      .filter((row) => row.purpose === PAYMENT_PURPOSE_MATERIAL_DEPOSIT)
      .reduce((sum, row) => sum.add(row.amount), new Prisma.Decimal(0));
    const due = required.sub(alreadyPaid);
    if (due.lte(0)) {
      return { applied: false, reason: "already_paid" };
    }
    const expectedCents = invoiceAmountToCents(due);
    if (payment.amountCents !== expectedCents) {
      return { applied: false, reason: "amount_mismatch" };
    }
    await invoiceRemainingReadTestHooks.afterRead();

    const job = estimate.jobs[0] ?? null;
    const invoiceId = job?.invoices[0]?.id ?? null;
    const recorded = await recordSucceededPayment(tx, {
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
      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId, businessId: estimate.businessId },
        select: { id: true, businessId: true, status: true },
      });
      if (invoice) {
        await maybeMarkInvoicePaid(tx, invoice, payment.paymentReference);
      }
    }
    return { applied: true, reason: "paid" };
  };

  return isPrismaClient(db) ? db.$transaction(applyLocked) : applyLocked(db);
}

const DEPOSIT_ESTIMATE_SELECT = {
  id: true,
  businessId: true,
  business: { select: { slug: true } },
  status: true,
  total: true,
  approvedOptionId: true,
  approvedOption: { select: { id: true, total: true } },
  approvedVersion: {
    select: {
      total: true,
      lineItems: { select: { type: true, total: true, description: true, optionId: true } },
    },
  },
  lineItems: { select: { type: true, total: true, description: true, optionId: true } },
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
  const job = await findLiveJobByProjectToken(db, token, {
    estimate: { select: DEPOSIT_ESTIMATE_SELECT },
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
  const loaded = await loadDepositEstimateByCustomerToken(db, token);
  const appUrl =
    options.appUrl ??
    (loaded ? getTenantAppOrigin(loaded.estimate.business.slug) : null) ??
    getAppUrl();
  if (!appUrl) {
    throw new PaymentError("App URL is not configured.");
  }
  if (!loaded || loaded.estimate.status !== "APPROVED") {
    throw new PaymentError("This deposit cannot be paid yet.");
  }
  const estimate = loaded.estimate;
  const chosen = resolveChosenCommercialScope({
    total: estimate.total,
    lineItems: estimate.lineItems,
    approvedOptionId: estimate.approvedOptionId,
    approvedOption: estimate.approvedOption,
    approvedVersion: estimate.approvedVersion,
  });
  const lines = chosen.lineItems;
  const total = chosen.total;
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
  if (!payment.paymentReady || !payment.stripeAccountId || !appUrl) {
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
  const chosen = resolveChosenCommercialScope({
    total: estimate.total,
    lineItems: estimate.lineItems,
    approvedOptionId: estimate.approvedOptionId,
    approvedOption: estimate.approvedOption,
    approvedVersion: estimate.approvedVersion,
  });
  const lines = chosen.lineItems;
  const total = chosen.total;
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
    const { breakdown } = await loadInvoicePaymentBreakdown(db, {
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
    ? await findLiveJobByProjectToken(db, token, {
        businessId: true,
        invoices: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, status: true, createdAt: true },
        },
      })
    : null;
  const invoice = selectPortalInvoice(job?.invoices ?? []);
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

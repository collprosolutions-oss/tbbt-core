import type { Metadata } from "next";
import { ApprovedScopeCard } from "@/components/jobs/approved-scope-card";
import { ChangeOrdersCard } from "@/components/portal/change-orders-card";
import { PayInvoiceButton } from "@/components/portal/pay-invoice-button";
import { ProjectProgressBar } from "@/components/portal/project-progress-bar";
import { RequestAdditionalWorkForm } from "@/components/portal/request-additional-work-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  CUSTOMER_VISIBLE_CHANGE_ORDER_STATUSES,
  resolveCurrentApprovedProjectTotal,
} from "@/lib/change-order";
import { formatAddress, formatDateTime, formatMoney } from "@/lib/format";
import { resolveApprovedWorkOrderScope } from "@/lib/job-work-order";
import {
  customerFacingJobStatusLabel,
  resolveProjectProgressStep,
} from "@/lib/project-progress";
import {
  getBusinessPaymentStatus,
  invoiceDueCents,
  reconcileProjectTokenCheckoutPayment,
  shouldShowPayInvoice,
} from "@/lib/payments";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Your Project",
};

const LINE_ITEM_SELECT = {
  description: true,
  quantity: true,
  unitPrice: true,
  total: true,
  type: true,
} as const;

/**
 * Customer Project Portal.
 *
 * SECURITY: this page is looked up by `token` alone -- Job.projectToken, an
 * unguessable unique value (see prisma/schema.prisma). It never accepts a
 * businessId, customerId, or jobId from the client, and every field
 * selected below is deliberately customer-safe: no internal notes, no
 * margins/cost basis, no other customers/jobs, no owner-only payment
 * metadata (paymentMethod/paymentReference), and no Job Photos (those stay
 * private until an explicit customer-visible/approval mechanism exists --
 * see the "Job Photos" note on the internal Work Order page). This route
 * also renders standalone, outside the authenticated (app) layout/AppShell,
 * so it never exposes any management navigation.
 */
export default async function CustomerProjectPortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ checkout?: string; session_id?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;

  const job = token
    ? await prisma.job.findUnique({
        where: { projectToken: token },
        select: {
          status: true,
          scheduledAt: true,
          scheduledDurationMinutes: true,
          business: { select: { id: true, name: true } },
          customer: { select: { name: true } },
          property: {
            select: {
              addressLine1: true,
              addressLine2: true,
              city: true,
              region: true,
              postalCode: true,
            },
          },
          estimate: {
            select: {
              total: true,
              lineItems: {
                orderBy: { createdAt: "asc" },
                select: LINE_ITEM_SELECT,
              },
            },
          },
          approvedEstimateVersion: {
            select: {
              versionNumber: true,
              total: true,
              laborMinimumAdjustment: true,
              approvedAt: true,
              lineItems: {
                orderBy: { createdAt: "asc" },
                select: LINE_ITEM_SELECT,
              },
            },
          },
          invoices: {
            select: { id: true, status: true, total: true, paidAt: true },
            take: 1,
            orderBy: { createdAt: "asc" },
          },
          // Only ever the statuses a customer is allowed to see -- a DRAFT
          // change order has never been sent, and a CANCELLED one was
          // withdrawn before the customer ever acted on it. See
          // CUSTOMER_VISIBLE_CHANGE_ORDER_STATUSES in
          // src/lib/change-order.ts.
          changeOrders: {
            where: { status: { in: [...CUSTOMER_VISIBLE_CHANGE_ORDER_STATUSES] } },
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              title: true,
              status: true,
              total: true,
              lineItems: {
                orderBy: { createdAt: "asc" },
                select: {
                  description: true,
                  quantity: true,
                  unitPrice: true,
                  total: true,
                },
              },
            },
          },
        },
      })
    : null;

  if (!job) {
    return (
      <main className="flex min-h-full items-center justify-center px-4 py-10">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Project unavailable</CardTitle>
            <CardDescription>This project link is not available.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  if (job.invoices[0]?.status === "SENT") {
    await reconcileProjectTokenCheckoutPayment(
      prisma,
      token,
      query.session_id,
    );
  }

  const invoice = job.invoices[0]
    ? await prisma.invoice.findFirst({
        where: { id: job.invoices[0].id, job: { projectToken: token } },
        select: { id: true, status: true, total: true, paidAt: true },
      })
    : null;
  const payment = invoice
    ? await getBusinessPaymentStatus(prisma, job.business.id)
    : null;
  const showPayInvoice = Boolean(
    invoice &&
      payment &&
      shouldShowPayInvoice({
        invoiceStatus: invoice.status,
        amountDueCents: invoiceDueCents(invoice.status, invoice.total),
        paymentReady: payment.paymentReady,
      }),
  );
  const approvedScope = resolveApprovedWorkOrderScope(job);
  const progressStep = resolveProjectProgressStep(job, invoice);
  const currentApprovedProjectTotal =
    approvedScope.source === "none"
      ? null
      : resolveCurrentApprovedProjectTotal(
          approvedScope.total,
          job.changeOrders,
        );

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            {job.business.name}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Your Project
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {job.customer?.name ? `For ${job.customer.name}. ` : ""}
            {job.property ? formatAddress(job.property) : ""}
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Project Status</CardTitle>
            <CardDescription>
              {customerFacingJobStatusLabel(job.status)}
              {job.scheduledAt
                ? ` · Scheduled ${formatDateTime(job.scheduledAt)}`
                : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProjectProgressBar currentStep={progressStep} />
          </CardContent>
        </Card>

        <ApprovedScopeCard scope={approvedScope} title="Original Approved Scope" />

        {currentApprovedProjectTotal !== null ? (
          <Card>
            <CardHeader>
              <CardTitle>Current Approved Project Total</CardTitle>
              <CardDescription>
                Your original approved total plus any change orders you have
                approved below. Pending or declined change orders are never
                included.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm font-medium">
              {formatMoney(currentApprovedProjectTotal)}
            </CardContent>
          </Card>
        ) : null}

        <ChangeOrdersCard projectToken={token} changeOrders={job.changeOrders} />

        <Card>
          <CardHeader>
            <CardTitle>Additional Work</CardTitle>
            <CardDescription>
              Have something else you&apos;d like us to look at? Send a
              request -- we&apos;ll follow up with pricing before anything is
              added to your project.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RequestAdditionalWorkForm projectToken={token} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Invoice</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {invoice ? (
              <>
                <p>Total: {formatMoney(invoice.total)}</p>
                <p>
                  {invoice.status === "PAID" ? (
                    <>
                      Paid
                      {invoice.paidAt
                        ? ` on ${formatDateTime(invoice.paidAt)}`
                        : ""}
                    </>
                  ) : (
                    "Outstanding"
                  )}
                </p>
                {invoice.status === "SENT" || invoice.status === "PAID" ? (
                  <p className="pt-2">
                    <a
                      href={`/p/${token}/invoice`}
                      className="underline underline-offset-4"
                    >
                      View Invoice
                    </a>
                    {" · "}
                    <a
                      href={`/p/${token}/invoice/pdf`}
                      className="underline underline-offset-4"
                    >
                      Download PDF
                    </a>
                  </p>
                ) : null}
                {query.checkout === "return" && invoice.status !== "PAID" ? (
                  <p className="pt-2 text-muted-foreground">
                    If you just paid, this invoice updates to Paid after
                    payment is confirmed.
                  </p>
                ) : null}
                {query.checkout === "cancelled" ? (
                  <p className="pt-2 text-muted-foreground">
                    Payment was cancelled. This invoice is still unpaid.
                  </p>
                ) : null}
                {showPayInvoice ? <PayInvoiceButton token={token} /> : null}
              </>
            ) : (
              <p className="text-muted-foreground">
                An invoice will appear here once your project is complete.
              </p>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          Questions about this project? Contact {job.business.name}.
        </p>
      </div>
    </main>
  );
}

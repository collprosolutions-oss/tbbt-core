import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyProjectLinkButton } from "@/components/jobs/copy-project-link-button";
import { MarkInvoicePaidForm } from "@/components/invoices/mark-invoice-paid-form";
import { OwnerPaymentsGoLiveBanner } from "@/components/payments/owner-payments-go-live";
import { MarkInvoiceSentButton } from "@/components/invoices/mark-invoice-sent-button";
import { WorkPerformedList } from "@/components/invoices/work-performed-list";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { RecordNav } from "@/components/record-nav";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireManagementPageAccess } from "@/lib/access";
import { formatDateTime, formatMoney } from "@/lib/format";
import { backfillEmptyInvoiceWorkLines } from "@/lib/invoice-carry-forward";
import { invoiceNumberFromId } from "@/lib/invoice-document";
import { paymentMethodLabel } from "@/lib/invoice-payment";
import {
  getBusinessPaymentStatus,
  reconcileStripeCheckoutPayment,
} from "@/lib/payments";
import { explainPaymentsGoLiveFromStatus } from "@/lib/payments/go-live";
import { prisma } from "@/lib/prisma";
import {
  invoicePaymentBreakdown,
  listProjectPayments,
} from "@/lib/project-payments";

export const metadata: Metadata = {
  title: "Invoice",
};

export default async function InvoicePage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  const access = await requireManagementPageAccess();
  const invoiceQuery = {
    where: { id: invoiceId, ...access.scope },
    include: {
      customer: { select: { name: true } },
      job: { select: { id: true, status: true, projectToken: true } },
      lineItems: {
        orderBy: { createdAt: "asc" as const },
        select: { description: true, quantity: true },
      },
    },
  } as const;
  let invoice = await prisma.invoice.findFirst(invoiceQuery);

  if (!invoice) {
    notFound();
  }
  access.assertOwned(invoice);

  if (invoice.status === "SENT") {
    await reconcileStripeCheckoutPayment(
      prisma,
      invoice.businessId,
      invoice.id,
    );
  }

  await backfillEmptyInvoiceWorkLines(prisma, {
    businessId: invoice.businessId,
    invoiceId: invoice.id,
  });
  invoice = (await prisma.invoice.findFirst(invoiceQuery)) ?? invoice;

  const payments = await listProjectPayments(prisma, {
    businessId: invoice.businessId,
    invoiceId: invoice.id,
    jobId: invoice.job?.id ?? null,
  });
  const breakdown = invoicePaymentBreakdown({
    status: invoice.status,
    total: invoice.total,
    payments,
  });
  const isDraft = invoice.status === "DRAFT";
  const isSent = invoice.status === "SENT";
  const isPaid = invoice.status === "PAID";
  const dueIsZero = breakdown.amountDue.lte(0);
  const payment = await getBusinessPaymentStatus(prisma, invoice.businessId);
  const paymentsGoLive = explainPaymentsGoLiveFromStatus(payment);
  const showCollectionHelp = isSent && !dueIsZero;

  return (
    <PageContainer>
      <PageHeader
        title={invoice.customer?.name ?? "Customer"}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <span>Invoice</span>
            <StatusBadge status={invoice.status} />
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href={`/invoices/${invoice.id}/preview`}>Preview Invoice</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={`/invoices/${invoice.id}/pdf`}>Download PDF</a>
          </Button>
          {isDraft ? <MarkInvoiceSentButton invoiceId={invoice.id} /> : null}
          {isSent ? <MarkInvoicePaidForm invoiceId={invoice.id} /> : null}
          {invoice.job?.projectToken && (isSent || isPaid) ? (
            <CopyProjectLinkButton
              projectToken={invoice.job.projectToken}
              hrefPath={`/p/${invoice.job.projectToken}/invoice`}
              label="Copy invoice link"
            />
          ) : null}
          {invoice.job ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/jobs/${invoice.job.id}`}>Open Job</Link>
            </Button>
          ) : null}
          <RecordNav
            customerId={invoice.customerId}
            backHref="/invoices"
            backLabel="Back to Invoices"
          />
        </div>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Customer invoice</CardTitle>
          <CardDescription>
            {invoiceNumberFromId(invoice.id)} — preview or download the
            customer-facing document. Sending and payment stay on this page.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link href={`/invoices/${invoice.id}/preview`}>Preview Invoice</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={`/invoices/${invoice.id}/pdf`}>Download PDF</a>
          </Button>
        </CardContent>
      </Card>

      {showCollectionHelp ? (
        <Card>
          <CardHeader>
            <CardTitle>Collect payment</CardTitle>
            <CardDescription>
              Share the customer invoice link. Use Mark Paid for cash, check, or
              Zelle. Card checkout appears for the customer only when online
              payments are live.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <OwnerPaymentsGoLiveBanner explanation={paymentsGoLive} />
            {invoice.job?.projectToken ? (
              <CopyProjectLinkButton
                projectToken={invoice.job.projectToken}
                hrefPath={`/p/${invoice.job.projectToken}/invoice`}
                label="Copy invoice link"
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                This invoice has no customer project link. Open the job once it
                exists, or send the PDF directly.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {paymentsGoLive.onlineCheckoutPossible
                ? "Customers can pay this invoice online from the link."
                : "Online card pay is not live. Record the payment with Mark Paid when the customer pays."}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Amount</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Customer: {invoice.customer?.name ?? "None"}</p>
          <WorkPerformedList
            lines={invoice.lineItems.map((line) => ({
              description: line.description,
              quantityLabel: line.quantity.toString(),
            }))}
          />
          <p>Invoice total: {formatMoney(breakdown.total)}</p>
          {breakdown.depositPaid.gt(0) ? (
            <p>Deposit paid: {formatMoney(breakdown.depositPaid)}</p>
          ) : null}
          <p>Payments: {formatMoney(breakdown.amountPaid)}</p>
          <p>Amount due: {formatMoney(breakdown.amountDue)}</p>
          {breakdown.credit.gt(0) ? (
            <p>Credit on account: {formatMoney(breakdown.credit)}</p>
          ) : null}
          {payments.length > 0 ? (
            <div className="space-y-1 pt-1">
              <p className="font-medium">View Payments</p>
              <ul className="space-y-1 text-muted-foreground">
                {payments.map((payment) => (
                  <li key={payment.id}>
                    {formatMoney(payment.amount)} ·{" "}
                    {payment.purpose === "MATERIAL_DEPOSIT"
                      ? "Deposit"
                      : "Payment"}{" "}
                    · {paymentMethodLabel(payment.method) ?? payment.method}
                    {payment.receivedAt
                      ? ` · ${formatDateTime(payment.receivedAt)}`
                      : ""}
                    {payment.note ? ` · ${payment.note}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {isPaid ? (
            <>
              <p>Paid: Yes</p>
              <p>
                Paid date/time:{" "}
                {invoice.paidAt ? formatDateTime(invoice.paidAt) : "Unknown"}
              </p>
              <p>
                Payment method:{" "}
                {paymentMethodLabel(invoice.paymentMethod) ?? "Unknown"}
              </p>
              {invoice.paymentReference ? (
                <p>Payment reference: {invoice.paymentReference}</p>
              ) : null}
            </>
          ) : null}
          <p>
            {isDraft
              ? "Mark this invoice sent once you've delivered it to the customer."
              : isSent
                ? dueIsZero
                  ? "Recorded payments already cover this invoice. Mark it paid when you are ready to close it."
                  : "Record the remaining balance here once the customer pays."
                : isPaid
                  ? "This invoice is paid and cannot be reopened."
                  : null}
          </p>
          <p>
            Job:{" "}
            {invoice.job ? (
              <Link
                href={`/jobs/${invoice.job.id}`}
                className="underline underline-offset-4"
              >
                {invoice.job.status}
              </Link>
            ) : (
              "None"
            )}
          </p>
        </CardContent>
      </Card>
    </PageContainer>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MarkInvoicePaidForm } from "@/components/invoices/mark-invoice-paid-form";
import { MarkInvoiceSentButton } from "@/components/invoices/mark-invoice-sent-button";
import { PageHeader } from "@/components/page-header";
import { RecordNav } from "@/components/record-nav";
import { StatusBadge } from "@/components/status-badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireManagementPageAccess } from "@/lib/access";
import { formatDateTime, formatMoney } from "@/lib/format";
import { paymentMethodLabel } from "@/lib/invoice-payment";
import { prisma } from "@/lib/prisma";

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
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, ...access.scope },
    include: {
      customer: { select: { name: true } },
      job: { select: { id: true, status: true } },
    },
  });

  if (!invoice) {
    notFound();
  }
  access.assertOwned(invoice);

  const isDraft = invoice.status === "DRAFT";
  const isSent = invoice.status === "SENT";
  const isPaid = invoice.status === "PAID";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
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
          {isDraft ? <MarkInvoiceSentButton invoiceId={invoice.id} /> : null}
          {isSent ? <MarkInvoicePaidForm invoiceId={invoice.id} /> : null}
          <RecordNav
            customerId={invoice.customerId}
            backHref="/invoices"
            backLabel="Back to Invoices"
          />
        </div>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Amount</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Customer: {invoice.customer?.name ?? "None"}</p>
          <p>Invoice total: {formatMoney(invoice.total)}</p>
          <p>Amount due: {isPaid ? formatMoney(0) : formatMoney(invoice.total)}</p>
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
                ? "Record payment here once the customer pays."
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
    </div>
  );
}

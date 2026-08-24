import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MarkInvoicePaidButton } from "@/components/invoices/mark-invoice-paid-button";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireBusinessAccess } from "@/lib/access";
import { formatMoney } from "@/lib/format";
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
  const access = await requireBusinessAccess();
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
        {invoice.status !== "PAID" ? (
          <MarkInvoicePaidButton invoiceId={invoice.id} />
        ) : null}
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Amount</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Customer: {invoice.customer?.name ?? "None"}</p>
          <p>Invoice total: {formatMoney(invoice.total)}</p>
          <p>Amount due: {formatMoney(invoice.total)}</p>
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

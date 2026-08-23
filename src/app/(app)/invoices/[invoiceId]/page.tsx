import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MarkInvoicePaidButton } from "@/components/invoices/mark-invoice-paid-button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireBusinessAccess } from "@/lib/access";
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
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Invoice</h1>
        {invoice.status === "PAID" ? (
          <p className="mt-2">
            <Badge className="h-6 px-3 text-sm font-semibold tracking-wide">
              PAID
            </Badge>
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            Status: {invoice.status}
          </p>
        )}
        {invoice.status !== "PAID" ? (
          <div className="mt-3">
            <MarkInvoicePaidButton invoiceId={invoice.id} />
          </div>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Amount</CardTitle>
          <CardDescription>Copied from the linked estimate.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Customer: {invoice.customer?.name ?? "None"}</p>
          <p>Invoice total: {invoice.total.toString()}</p>
          <p>Amount due: {invoice.total.toString()}</p>
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

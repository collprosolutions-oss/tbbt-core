import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireBusinessAccess } from "@/lib/access";
import { formatDate, formatMoney } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Invoices",
};

export default async function InvoicesPage() {
  const access = await requireBusinessAccess();
  const invoices = await prisma.invoice.findMany({
    where: access.scope,
    include: {
      customer: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Invoices"
        description={`Invoices for ${access.workspace.business.name}.`}
      />

      {invoices.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No invoices yet</CardTitle>
            <CardDescription>
              Create an invoice from a completed job.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm">
              <Link href="/jobs">Open jobs</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {invoices.map((invoice) => (
            <Card key={invoice.id}>
              <CardHeader>
                <CardTitle>{invoice.customer?.name ?? "Customer"}</CardTitle>
                <CardDescription>{formatDate(invoice.createdAt)}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={invoice.status} />
                  <span>{formatMoney(invoice.total)}</span>
                </div>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/invoices/${invoice.id}`}>Open</Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

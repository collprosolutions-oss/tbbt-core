import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageContainer } from "@/components/page-container";
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
import { requireManagementPageAccess } from "@/lib/access";
import { formatDate, formatMoney } from "@/lib/format";
import { paymentMethodLabel } from "@/lib/invoice-payment";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Invoices",
};

export default async function InvoicesPage() {
  const access = await requireManagementPageAccess();
  const invoices = await prisma.invoice.findMany({
    where: access.scope,
    include: {
      customer: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <PageContainer>
      <PageHeader
        title="Invoices"
        description={`Invoices for ${access.workspace.business.name}.`}
      />

      {invoices.length === 0 ? (
        <EmptyState
          title="No invoices yet"
          description="Create an invoice from a completed job."
          action={
            <Button asChild size="sm">
              <Link href="/jobs">Open jobs</Link>
            </Button>
          }
        />
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
                  {invoice.status === "PAID" ? (
                    <span className="text-muted-foreground">
                      {paymentMethodLabel(invoice.paymentMethod) ?? "Unknown"}
                    </span>
                  ) : null}
                </div>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/invoices/${invoice.id}`}>Open</Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </PageContainer>
  );
}

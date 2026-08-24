import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AddCatalogLineForm } from "@/components/estimates/add-catalog-line-form";
import { AddCustomLineForm } from "@/components/estimates/add-custom-line-form";
import { CreateJobButton } from "@/components/jobs/create-job-button";
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
import { formatMoney } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Estimate",
};

export default async function EstimateBuilderPage({
  params,
}: {
  params: Promise<{ estimateId: string }>;
}) {
  const { estimateId } = await params;
  const access = await requireBusinessAccess();

  const estimate = await prisma.estimate.findFirst({
    where: { id: estimateId, ...access.scope },
    include: {
      customer: { select: { name: true } },
      serviceRequest: { select: { description: true } },
      jobs: { select: { id: true }, take: 1, orderBy: { createdAt: "asc" } },
      lineItems: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!estimate) {
    notFound();
  }
  access.assertOwned(estimate);

  const catalogItems = await prisma.serviceCatalogItem.findMany({
    where: { ...access.scope, active: true },
    orderBy: { name: "asc" },
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={estimate.customer?.name ?? "Customer"}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <span>Estimate</span>
            <StatusBadge status={estimate.status} />
            <span>{formatMoney(estimate.total)}</span>
          </div>
        }
      >
        <p className="text-sm text-muted-foreground">
          Customer view:{" "}
          <Link
            href={`/e/${estimate.publicToken}`}
            className="underline underline-offset-4"
          >
            /e/{estimate.publicToken}
          </Link>
        </p>
        {estimate.serviceRequest?.description ? (
          <p className="mt-2 text-sm text-foreground">
            {estimate.serviceRequest.description}
          </p>
        ) : null}
        <div className="mt-3">
          {estimate.jobs[0] ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/jobs/${estimate.jobs[0].id}`}>Open job</Link>
            </Button>
          ) : estimate.status === "APPROVED" ? (
            <CreateJobButton estimateId={estimate.id} />
          ) : null}
        </div>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Line items</CardTitle>
          <CardDescription>Server-calculated totals.</CardDescription>
        </CardHeader>
        <CardContent>
          {estimate.lineItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No line items yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {estimate.lineItems.map((item) => (
                <li key={item.id} className="flex justify-between gap-3">
                  <span>
                    {item.description} × {item.quantity.toString()} @{" "}
                    {formatMoney(item.unitPrice)}
                  </span>
                  <span>{formatMoney(item.total)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-sm font-medium">
            Estimate total: {formatMoney(estimate.total)}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add catalog item</CardTitle>
        </CardHeader>
        <CardContent>
          <AddCatalogLineForm
            estimateId={estimate.id}
            items={catalogItems.map((item) => ({
              id: item.id,
              name: item.name,
              price: item.price.toString(),
            }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add custom item</CardTitle>
        </CardHeader>
        <CardContent>
          <AddCustomLineForm estimateId={estimate.id} />
        </CardContent>
      </Card>
    </div>
  );
}

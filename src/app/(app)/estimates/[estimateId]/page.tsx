import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AddCatalogLineForm } from "@/components/estimates/add-catalog-line-form";
import { AddCustomLineForm } from "@/components/estimates/add-custom-line-form";
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
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Estimate</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {estimate.customer?.name ?? "Customer"} · {estimate.status} · Total{" "}
          {estimate.total.toString()}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Customer view: /e/{estimate.publicToken}
        </p>
        {estimate.serviceRequest?.description ? (
          <p className="mt-2 text-sm">{estimate.serviceRequest.description}</p>
        ) : null}
      </div>

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
                    {item.unitPrice.toString()}
                  </span>
                  <span>{item.total.toString()}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-sm font-medium">
            Estimate total: {estimate.total.toString()}
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

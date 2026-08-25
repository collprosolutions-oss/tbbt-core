import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Prisma } from "@prisma/client";
import { AddCatalogLineForm } from "@/components/estimates/add-catalog-line-form";
import { AddCustomLineForm } from "@/components/estimates/add-custom-line-form";
import { ClearDraftEstimateButton } from "@/components/estimates/clear-draft-estimate-button";
import { CopyEstimateLinkButton } from "@/components/estimates/copy-estimate-link-button";
import { EditEstimateButton } from "@/components/estimates/edit-estimate-button";
import { EmailEstimateButton } from "@/components/estimates/email-estimate-button";
import { RemoveLineItemButton } from "@/components/estimates/remove-line-item-button";
import { SendEstimateButton } from "@/components/estimates/send-estimate-button";
import { WaiveLaborMinimumButton } from "@/components/estimates/waive-labor-minimum-button";
import { CreateJobButton } from "@/components/jobs/create-job-button";
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
import { requireBusinessAccess } from "@/lib/access";
import { formatAddress, formatMoney } from "@/lib/format";
import { isUsableEmail } from "@/lib/mail";
import { formatCatalogPriceLabel } from "@/lib/pricing-mode";
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
      customer: { select: { name: true, email: true } },
      property: {
        select: {
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
        },
      },
      serviceRequest: { select: { description: true } },
      jobs: { select: { id: true }, take: 1, orderBy: { createdAt: "asc" } },
      lineItems: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!estimate) {
    notFound();
  }
  access.assertOwned(estimate);

  const laborSubtotal = estimate.lineItems
    .filter((item) => item.type === "LABOR")
    .reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0));
  const materialSubtotal = estimate.lineItems
    .filter((item) => item.type === "MATERIAL")
    .reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0));
  const otherSubtotal = estimate.lineItems
    .filter((item) => item.type === "OTHER")
    .reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0));
  const business = access.workspace.business;
  const isDraft = estimate.status === "DRAFT";
  const isSent = estimate.status === "SENT";
  const isApproved = estimate.status === "APPROVED";
  const customerEmail = estimate.customer?.email ?? "";
  const hasCustomerEmail = isUsableEmail(customerEmail);

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
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <p>
            Customer view:{" "}
            <Link
              href={`/e/${estimate.publicToken}`}
              className="underline underline-offset-4"
            >
              /e/{estimate.publicToken}
            </Link>
          </p>
          {isSent || isApproved ? (
            <CopyEstimateLinkButton publicToken={estimate.publicToken} />
          ) : null}
        </div>
        {isSent ? (
          <p className="mt-2 text-sm text-foreground">
            This is the estimate currently presented to the customer. Editing
            returns it to draft, and you must send it again before they can
            approve.
          </p>
        ) : null}
        {isApproved ? (
          <p className="mt-2 text-sm text-muted-foreground">
            This estimate is approved and cannot be edited.
          </p>
        ) : null}
        {estimate.serviceRequestId ? (
          estimate.serviceRequest?.description ? (
            <p className="mt-2 text-sm text-foreground">
              {estimate.serviceRequest.description}
            </p>
          ) : null
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">Manual estimate</p>
        )}
        <p className="mt-2 text-sm text-muted-foreground">
          Service address:{" "}
          {estimate.property
            ? formatAddress(estimate.property)
            : "None selected"}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {isDraft ? (
            <SendEstimateButton
              estimateId={estimate.id}
              disabled={estimate.lineItems.length === 0}
            />
          ) : null}
          {isSent ? <EditEstimateButton estimateId={estimate.id} /> : null}
          {isSent && hasCustomerEmail ? (
            <EmailEstimateButton estimateId={estimate.id} />
          ) : null}
          {isSent && !hasCustomerEmail ? (
            <p className="text-sm text-muted-foreground">
              No customer email on file. Add/copy the estimate link manually.
            </p>
          ) : null}
          {estimate.jobs[0] ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/jobs/${estimate.jobs[0].id}`}>Open job</Link>
            </Button>
          ) : isApproved ? (
            <CreateJobButton estimateId={estimate.id} />
          ) : null}
          <RecordNav
            customerId={estimate.customerId}
            backHref="/estimates"
            backLabel="Back to Estimates"
          />
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
                <li
                  key={item.id}
                  className="flex items-start justify-between gap-3"
                >
                  <span>
                    {item.type === "LABOR"
                      ? "Labor"
                      : item.type === "MATERIAL"
                        ? "Material"
                        : "Other"}
                    : {item.description} × {item.quantity.toString()} @{" "}
                    {formatMoney(item.unitPrice)}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span>{formatMoney(item.total)}</span>
                    {isDraft ? (
                      <RemoveLineItemButton
                        estimateId={estimate.id}
                        lineItemId={item.id}
                      />
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 space-y-1 text-sm">
            <p>Labor subtotal: {formatMoney(laborSubtotal)}</p>
            {materialSubtotal.gt(0) ? (
              <p>Materials: {formatMoney(materialSubtotal)}</p>
            ) : null}
            {otherSubtotal.gt(0) ? (
              <p>Other: {formatMoney(otherSubtotal)}</p>
            ) : null}
            {isDraft &&
            business.laborMinimumEnabled &&
            business.laborMinimumAmount ? (
              <p>
                Minimum required: {formatMoney(business.laborMinimumAmount)}
              </p>
            ) : null}
            {estimate.laborMinimumWaived ? (
              <p>Labor minimum waived for this estimate.</p>
            ) : null}
            {estimate.laborMinimumAdjustment.gt(0) ? (
              <p>
                Labor Minimum Service Fee Adjustment —{" "}
                {formatMoney(estimate.laborMinimumAdjustment)}
              </p>
            ) : (
              <p>Minimum adjustment: {formatMoney(0)}</p>
            )}
            <p className="font-medium">
              Estimate total: {formatMoney(estimate.total)}
            </p>
          </div>
          {isDraft ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <WaiveLaborMinimumButton
                estimateId={estimate.id}
                waived={estimate.laborMinimumWaived}
              />
              {estimate.lineItems.length > 0 ? (
                <ClearDraftEstimateButton estimateId={estimate.id} />
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {isDraft ? (
        <>
      <Card>
        <CardHeader>
          <CardTitle>Add catalog item</CardTitle>
          <CardDescription>
            Uses the current catalog price. Custom Quote services need a job
            price when added. The line is saved as a snapshot and will not
            change if the catalog is edited later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AddCatalogLineForm
            estimateId={estimate.id}
            items={catalogItems.map((item) => ({
              id: item.id,
              name: item.name,
              pricingMode: item.pricingMode,
              priceLabel: formatCatalogPriceLabel(item.pricingMode, item.price),
            }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add custom item</CardTitle>
          <CardDescription>
            Choose Labor, Material, or Other. The labor minimum uses labor
            lines only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AddCustomLineForm estimateId={estimate.id} />
        </CardContent>
      </Card>
        </>
      ) : null}
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { ApproveEstimateButton } from "@/components/estimates/approve-estimate-button";
import { CustomerEstimateHeader } from "@/components/estimates/customer-estimate-header";
import { EstimateCustomerPolicies } from "@/components/estimates/customer-policy-display";
import { IncludedWorkDisplay } from "@/components/estimates/included-work-display";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getBusinessLogoSrc } from "@/lib/business-branding";
import { lineCustomerPolicies, lineItemTitle } from "@/lib/estimate-line-scope";
import { uniqueCustomerPolicies } from "@/lib/estimate-policies";
import { formatAddress, formatMoney } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Estimate",
};

export default async function PublicEstimatePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const estimate = await prisma.estimate.findUnique({
    where: { publicToken: token },
    select: {
      publicToken: true,
      status: true,
      total: true,
      laborMinimumAdjustment: true,
      business: { select: { name: true, slug: true } },
      property: {
        select: {
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
        },
      },
      lineItems: {
        orderBy: { createdAt: "asc" },
        select: {
          description: true,
          quantity: true,
          unitPrice: true,
          total: true,
        },
      },
      // The immutable snapshot of what was actually sent. While an
      // estimate's status is SENT/APPROVED, application code guarantees the
      // live fields above and this current version's fields are identical
      // (no action mutates line items/totals outside DRAFT) -- this page
      // reads from the version explicitly so it stays correct even if that
      // invariant is ever loosened later, and so approval can be bound to
      // the exact version id shown here.
      versions: {
        orderBy: { versionNumber: "desc" },
        take: 1,
        select: {
          id: true,
          versionNumber: true,
          total: true,
          laborMinimumAdjustment: true,
          propertyAddressLine1: true,
          propertyAddressLine2: true,
          propertyCity: true,
          propertyRegion: true,
          propertyPostalCode: true,
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
  });

  if (!estimate) {
    return (
      <main className="flex min-h-full items-center justify-center px-4 py-10">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Estimate unavailable</CardTitle>
            <CardDescription>This estimate is not available.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  // Legacy estimates sent before estimate versioning existed may have no
  // version yet (see prisma/migrations/*_add_estimate_version_integrity).
  // Fall back to the live estimate fields for display only; approveEstimate
  // still refuses to approve without a bound version until this estimate is
  // re-sent, which creates Version 1.
  const currentVersion = estimate.versions[0] ?? null;
  const total = currentVersion?.total ?? estimate.total;
  const laborMinimumAdjustment =
    currentVersion?.laborMinimumAdjustment ?? estimate.laborMinimumAdjustment;
  const lineItems = currentVersion?.lineItems ?? estimate.lineItems;
  const property = currentVersion
    ? currentVersion.propertyAddressLine1
      ? {
          addressLine1: currentVersion.propertyAddressLine1,
          addressLine2: currentVersion.propertyAddressLine2,
          city: currentVersion.propertyCity,
          region: currentVersion.propertyRegion,
          postalCode: currentVersion.propertyPostalCode,
        }
      : null
    : estimate.property;
  const logoSrc = getBusinessLogoSrc(estimate.business.slug);
  const customerPolicies = uniqueCustomerPolicies(
    lineItems.map((item) => lineCustomerPolicies(item.description)),
  );

  return (
    <main className="min-h-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mx-auto w-full max-w-[1200px] space-y-6">
        <CustomerEstimateHeader
          businessName={estimate.business.name}
          logoSrc={logoSrc}
          status={estimate.status}
          totalLabel={formatMoney(total)}
        />

        <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>Services</CardTitle>
              <CardDescription>
                What is included in this estimate.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {lineItems.length === 0 ? (
                <p className="text-sm text-muted-foreground">No line items.</p>
              ) : (
                <ul className="space-y-5">
                  {lineItems.map((item, index) => (
                    <li key={index} className="space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium">
                            {lineItemTitle(item.description)}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            Qty {item.quantity.toString()} ·{" "}
                            {formatMoney(item.unitPrice)}
                          </p>
                        </div>
                        <p className="shrink-0 font-medium">
                          {formatMoney(item.total)}
                        </p>
                      </div>
                      <IncludedWorkDisplay description={item.description} />
                    </li>
                  ))}
                </ul>
              )}
              {laborMinimumAdjustment.gt(0) ? (
                <p className="text-sm">
                  Labor Minimum Service Fee Adjustment —{" "}
                  {formatMoney(laborMinimumAdjustment)}
                </p>
              ) : null}
              {property ? (
                <p className="text-sm">
                  Service address: {formatAddress(property)}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="hidden h-fit md:block">
            <CardHeader>
              <CardTitle>Estimate summary</CardTitle>
              <CardDescription>
                Status {estimate.status} · Total {formatMoney(total)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-2xl font-semibold tracking-tight">
                {formatMoney(total)}
              </p>
              <Button asChild variant="outline" className="w-full">
                <Link href={`/e/${estimate.publicToken}/print`}>Print / PDF</Link>
              </Button>
              <ApproveEstimateButton
                publicToken={estimate.publicToken}
                status={estimate.status}
                currentVersionId={currentVersion?.id}
              />
            </CardContent>
          </Card>

          {customerPolicies.length > 0 ? (
            <Card className="md:col-span-2">
              <CardContent className="pt-6">
                <EstimateCustomerPolicies
                  className="max-w-none space-y-4"
                  descriptions={lineItems.map((item) => item.description)}
                />
              </CardContent>
            </Card>
          ) : null}

          <Card className="md:hidden">
            <CardHeader>
              <CardTitle>Approve this estimate</CardTitle>
              <CardDescription>Total {formatMoney(total)}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button asChild variant="outline" className="w-full">
                <Link href={`/e/${estimate.publicToken}/print`}>Print / PDF</Link>
              </Button>
              <ApproveEstimateButton
                publicToken={estimate.publicToken}
                status={estimate.status}
                currentVersionId={currentVersion?.id}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}

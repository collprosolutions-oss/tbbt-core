import type { Metadata } from "next";
import { ApproveEstimateButton } from "@/components/estimates/approve-estimate-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Estimate</CardTitle>
          <CardDescription>
            Status {estimate.status} · Total {formatMoney(total)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {lineItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No line items.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {lineItems.map((item, index) => (
                <li key={index} className="flex justify-between gap-3">
                  <span>
                    {item.description} × {item.quantity.toString()} @{" "}
                    {formatMoney(item.unitPrice)}
                  </span>
                  <span>{formatMoney(item.total)}</span>
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
            <p className="text-sm">Service address: {formatAddress(property)}</p>
          ) : null}
          <p className="text-sm font-medium">
            Estimate total: {formatMoney(total)}
          </p>
          <ApproveEstimateButton
            publicToken={estimate.publicToken}
            status={estimate.status}
            currentVersionId={currentVersion?.id}
          />
        </CardContent>
      </Card>
    </main>
  );
}

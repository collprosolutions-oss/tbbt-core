import type { Metadata } from "next";
import Link from "next/link";
import { ApproveEstimateButton } from "@/components/estimates/approve-estimate-button";
import { CustomerEstimateHeader } from "@/components/estimates/customer-estimate-header";
import { CustomerEstimateLineSections } from "@/components/estimates/customer-estimate-line-sections";
import { CustomerEstimateTotals } from "@/components/estimates/customer-estimate-totals";
import { EstimateCustomerPolicies } from "@/components/estimates/customer-policy-display";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getBusinessLogoSrc } from "@/lib/business-branding";
import { loadEstimateDocumentByToken } from "@/lib/estimate-document";

export const metadata: Metadata = {
  title: "Estimate",
};

export default async function PublicEstimatePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const estimate = await loadEstimateDocumentByToken(token);

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

  const logoSrc = getBusinessLogoSrc(estimate.business.slug);
  const hasLines =
    estimate.laborLines.length > 0 ||
    estimate.materialLines.length > 0 ||
    estimate.otherLines.length > 0;

  return (
    <main className="min-h-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mx-auto w-full max-w-[1200px] space-y-6">
        <CustomerEstimateHeader
          businessName={estimate.business.name}
          logoSrc={logoSrc}
          status={estimate.status}
          totalLabel={estimate.totalLabel}
        />

        <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>What&apos;s included</CardTitle>
              <CardDescription>
                Labor and materials included in this estimate.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {hasLines ? (
                <CustomerEstimateLineSections
                  laborLines={estimate.laborLines}
                  materialLines={estimate.materialLines}
                  otherLines={estimate.otherLines}
                />
              ) : (
                <p className="text-sm text-muted-foreground">No line items.</p>
              )}
              {estimate.serviceAddress ? (
                <p className="text-sm">Service address: {estimate.serviceAddress}</p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="hidden h-fit md:block">
            <CardHeader>
              <CardTitle>Estimate summary</CardTitle>
              <CardDescription>
                Status {estimate.status} · Total {estimate.totalLabel}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <CustomerEstimateTotals document={estimate} />
              <Button asChild variant="outline" className="w-full">
                <Link href={`/e/${estimate.publicToken}/print`}>Print / PDF</Link>
              </Button>
              <ApproveEstimateButton
                publicToken={estimate.publicToken}
                status={estimate.status}
                currentVersionId={estimate.currentVersionId ?? undefined}
              />
            </CardContent>
          </Card>

          {estimate.projectConditions || estimate.terms.length > 0 ? (
            <Card className="md:col-span-2">
              <CardContent className="pt-6">
                <EstimateCustomerPolicies
                  className="max-w-none space-y-4"
                  projectConditions={estimate.projectConditions}
                  terms={estimate.terms}
                />
              </CardContent>
            </Card>
          ) : null}

          <Card className="md:hidden">
            <CardHeader>
              <CardTitle>Approve this estimate</CardTitle>
              <CardDescription>Total {estimate.totalLabel}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <CustomerEstimateTotals document={estimate} />
              <Button asChild variant="outline" className="w-full">
                <Link href={`/e/${estimate.publicToken}/print`}>Print / PDF</Link>
              </Button>
              <ApproveEstimateButton
                publicToken={estimate.publicToken}
                status={estimate.status}
                currentVersionId={estimate.currentVersionId ?? undefined}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}

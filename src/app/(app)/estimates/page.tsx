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
  title: "Estimates",
};

export default async function EstimatesPage() {
  const access = await requireBusinessAccess();
  const estimates = await prisma.estimate.findMany({
    where: access.scope,
    include: {
      customer: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Estimates"
        description={`Estimates for ${access.workspace.business.name}.`}
      >
        <Button asChild size="sm">
          <Link href="/estimates/new">Create Estimate</Link>
        </Button>
      </PageHeader>

      {estimates.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No estimates yet</CardTitle>
            <CardDescription>
              Create a manual draft, or open a service request and estimate from
              there.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild size="sm">
              <Link href="/estimates/new">Create Estimate</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/requests">Open requests</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {estimates.map((estimate) => (
            <Card key={estimate.id}>
              <CardHeader>
                <CardTitle>{estimate.customer?.name ?? "Customer"}</CardTitle>
                <CardDescription>{formatDate(estimate.createdAt)}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={estimate.status} />
                  <span>{formatMoney(estimate.total)}</span>
                  {estimate.serviceRequestId ? null : (
                    <span className="text-muted-foreground">Manual estimate</span>
                  )}
                </div>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/estimates/${estimate.id}`}>Open</Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

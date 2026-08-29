import type { Metadata } from "next";
import Link from "next/link";
import { CreateEstimateButton } from "@/components/estimates/create-estimate-button";
import { EmptyState } from "@/components/empty-state";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { requireManagementPageAccess } from "@/lib/access";
import { formatDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Requests",
};

export default async function RequestsPage() {
  const access = await requireManagementPageAccess();
  const requests = await prisma.serviceRequest.findMany({
    where: access.scope,
    include: {
      customer: { select: { name: true, email: true, phone: true } },
      property: { select: { addressLine1: true } },
      serviceCatalogItem: { select: { name: true } },
      estimates: {
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <PageContainer>
      <PageHeader
        title="Requests"
        description={`Service requests for ${access.workspace.business.name}.`}
      />

      {requests.length === 0 ? (
        <EmptyState
          title="No requests yet"
          description="Public intake submissions for this workspace will appear here."
        />
      ) : (
        <div className="space-y-3">
          {requests.map((request) => (
            <Card key={request.id}>
              <CardHeader>
                <CardTitle>{request.customer?.name ?? "Customer"}</CardTitle>
                <CardDescription>
                  {formatDateTime(request.createdAt)}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <StatusBadge status={request.status} />
                {request.serviceCatalogItem ? (
                  <p className="font-medium">
                    {request.serviceCatalogItem.name}
                  </p>
                ) : null}
                <p>{request.description || "No description"}</p>
                {request.property?.addressLine1 ? (
                  <p className="text-muted-foreground">
                    {request.property.addressLine1}
                  </p>
                ) : null}
                <div className="pt-2">
                  {request.estimates[0] ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/estimates/${request.estimates[0].id}`}>
                        Open estimate
                      </Link>
                    </Button>
                  ) : (
                    <CreateEstimateButton serviceRequestId={request.id} />
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </PageContainer>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CreateEstimateButton } from "@/components/estimates/create-estimate-button";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { RecordNav } from "@/components/record-nav";
import {
  RequestContactActions,
  RequestIdentityReviewBadge,
  RequestIdentityReviewNotice,
  RequestRecordedContact,
} from "@/components/requests/request-follow-up";
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
import { formatAddress, formatDate, formatMoney } from "@/lib/format";
import { loadRecordJourney } from "@/lib/record-nav";
import { prisma } from "@/lib/prisma";
import { requestIdentityReviewContext } from "@/lib/request-follow-up";
import {
  requestedWorkLabels,
  requestedWorkSummary,
} from "@/lib/service-request-work";
import { requestNotesText } from "@/lib/work-area-intake";

export const metadata: Metadata = {
  title: "Request",
};

export default async function RequestRecordPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  const access = await requireManagementPageAccess();
  const request = await prisma.serviceRequest.findFirst({
    where: { id: requestId, ...access.scope },
    include: {
      customer: { select: { id: true, name: true, email: true, phone: true } },
      property: {
        select: {
          id: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
        },
      },
      serviceCatalogItem: { select: { name: true } },
      items: {
        orderBy: { sortOrder: "asc" },
        select: {
          customDescription: true,
          serviceCatalogItem: { select: { id: true, name: true } },
        },
      },
      estimates: {
        select: { id: true, status: true, total: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!request) {
    notFound();
  }
  access.assertOwned(request);

  const recordNavItems = await loadRecordJourney(prisma, access, {
    kind: "request",
    id: request.id,
  });
  const requestedTasks = requestedWorkLabels(request);
  const serviceName =
    requestedWorkSummary(requestedTasks) ??
    request.serviceCatalogItem?.name ??
    "Not specified";
  const identityReview = requestIdentityReviewContext(request.description);

  return (
    <PageContainer>
      <PageHeader
        title={request.customer?.name ?? "Request"}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <span>Service request</span>
            <StatusBadge status={request.status} />
            <RequestIdentityReviewBadge review={identityReview} />
            <span>{formatDate(request.createdAt)}</span>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {request.estimates.length === 0 ? (
            <CreateEstimateButton serviceRequestId={request.id} />
          ) : null}
          <RecordNav
            items={recordNavItems}
            backHref="/requests"
            backLabel="Back to Requests"
          />
        </div>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Requested work</CardTitle>
          <CardDescription>{serviceName}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {requestedTasks.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5">
              {requestedTasks.map((task) => (
                <li key={task}>{task}</li>
              ))}
            </ul>
          ) : (
            <p>{serviceName}</p>
          )}
          <p className="text-muted-foreground">
            {requestNotesText(request.description) ||
              request.summary ||
              "No description provided."}
          </p>
          <p>
            Service address:{" "}
            {request.property ? formatAddress(request.property) : "None on file"}
          </p>
          {request.estimates.length > 0 ? (
            <div className="space-y-2">
              {request.estimates.map((estimate) => (
                <p key={estimate.id} className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={estimate.status} />
                  <span>{formatMoney(estimate.total)}</span>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/estimates/${estimate.id}`}>Open estimate</Link>
                  </Button>
                </p>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Customer contact</CardTitle>
          <CardDescription>Recorded follow-up details for this request.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <RequestIdentityReviewNotice review={identityReview} />
          <RequestRecordedContact
            phone={request.customer?.phone}
            email={request.customer?.email}
          />
          <div className="flex flex-wrap gap-2">
            <RequestContactActions
              phone={request.customer?.phone}
              email={request.customer?.email}
              size="sm"
            />
            {request.customer ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/customers/${request.customer.id}`}>Open customer</Link>
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </PageContainer>
  );
}

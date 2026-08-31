import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EditCustomerForm } from "@/components/customers/edit-customer-form";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { AddPropertyForm } from "@/components/properties/add-property-form";
import { PropertyItem } from "@/components/properties/property-item";
import { RecordRow } from "@/components/record-row";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireManagementPageAccess } from "@/lib/access";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Customer",
};

export default async function CustomerProfilePage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;
  const access = await requireManagementPageAccess();
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, ...access.scope },
    include: {
      properties: { orderBy: { createdAt: "asc" } },
      serviceRequests: { orderBy: { createdAt: "desc" } },
      estimates: { orderBy: { createdAt: "desc" } },
      jobs: { orderBy: { createdAt: "desc" } },
      invoices: { orderBy: { createdAt: "desc" } },
      reviewRequests: { orderBy: { createdAt: "desc" }, take: 8 },
      reviews: { orderBy: { createdAt: "desc" }, take: 8 },
    },
  });

  if (!customer) {
    notFound();
  }
  access.assertOwned(customer);

  return (
    <PageContainer>
      <PageHeader
        title={customer.name}
        description="Customer profile"
      >
        <Button asChild size="sm" variant="outline">
          <Link href="/customers">Back to customers</Link>
        </Button>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Contact information</CardTitle>
        </CardHeader>
        <CardContent>
          <EditCustomerForm
            customer={{
              id: customer.id,
              name: customer.name,
              email: customer.email,
              phone: customer.phone,
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Service addresses</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {customer.properties.length === 0 ? (
            <p className="text-sm text-muted-foreground">No addresses on file.</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {customer.properties.map((property) => (
                <PropertyItem key={property.id} property={property} />
              ))}
            </ul>
          )}
          <AddPropertyForm customerId={customer.id} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Service requests</CardTitle>
        </CardHeader>
        <CardContent>
          {customer.serviceRequests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            <div className="space-y-2">
              {customer.serviceRequests.map((request) => (
                <RecordRow
                  key={request.id}
                  title={
                    <span className="font-normal text-foreground">
                      {request.description || request.summary || "No description"}
                    </span>
                  }
                  meta={
                    <>
                      <StatusBadge status={request.status} />
                      <span>{formatDate(request.createdAt)}</span>
                    </>
                  }
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Estimates</CardTitle>
        </CardHeader>
        <CardContent>
          {customer.estimates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No estimates yet.</p>
          ) : (
            <div className="space-y-2">
              {customer.estimates.map((estimate) => (
                <RecordRow
                  key={estimate.id}
                  title={
                    <>
                      <StatusBadge status={estimate.status} />
                      <span className="text-foreground">{formatMoney(estimate.total)}</span>
                    </>
                  }
                  meta={<span>{formatDate(estimate.createdAt)}</span>}
                  action={
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/estimates/${estimate.id}`}>Open</Link>
                    </Button>
                  }
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {customer.jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No jobs yet.</p>
          ) : (
            <div className="space-y-2">
              {customer.jobs.map((job) => (
                <RecordRow
                  key={job.id}
                  title={<StatusBadge status={job.status} />}
                  meta={
                    <span>
                      {job.scheduledAt
                        ? formatDateTime(job.scheduledAt)
                        : formatDate(job.createdAt)}
                    </span>
                  }
                  action={
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/jobs/${job.id}`}>Open</Link>
                    </Button>
                  }
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {customer.invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices yet.</p>
          ) : (
            <div className="space-y-2">
              {customer.invoices.map((invoice) => (
                <RecordRow
                  key={invoice.id}
                  title={
                    <>
                      <StatusBadge status={invoice.status} />
                      <span className="text-foreground">{formatMoney(invoice.total)}</span>
                    </>
                  }
                  meta={<span>{formatDate(invoice.createdAt)}</span>}
                  action={
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/invoices/${invoice.id}`}>Open</Link>
                    </Button>
                  }
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Review activity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {customer.reviewRequests.length === 0 && customer.reviews.length === 0 ? (
            <p className="text-sm text-muted-foreground">No review requests or recorded reviews yet.</p>
          ) : (
            <div className="space-y-2">
              {customer.reviewRequests.map((request) => (
                <RecordRow
                  key={request.id}
                  title={
                    <>
                      <span className="font-normal text-foreground">Review request</span>
                      <StatusBadge status={request.status} />
                    </>
                  }
                  meta={<span>{formatDate(request.createdAt)}</span>}
                  action={
                    <Button asChild size="sm" variant="outline">
                      <Link href="/reviews?area=requests">Open Reviews</Link>
                    </Button>
                  }
                />
              ))}
              {customer.reviews.map((review) => (
                <RecordRow
                  key={review.id}
                  title={
                    <>
                      <span className="font-normal text-foreground">Review received</span>
                      <StatusBadge status={review.responseStatus} />
                    </>
                  }
                  meta={
                    <span>
                      {review.rating ? `${review.rating}★ · ` : ""}
                      {formatDate(review.externalReviewDate ?? review.createdAt)}
                    </span>
                  }
                  action={
                    <Button asChild size="sm" variant="outline">
                      <Link href="/reviews?area=reviews">Open Reviews</Link>
                    </Button>
                  }
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}

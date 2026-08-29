import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EditCustomerForm } from "@/components/customers/edit-customer-form";
import { PageHeader } from "@/components/page-header";
import { AddPropertyForm } from "@/components/properties/add-property-form";
import { PropertyItem } from "@/components/properties/property-item";
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
    },
  });

  if (!customer) {
    notFound();
  }
  access.assertOwned(customer);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
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
            <ul className="space-y-3 text-sm">
              {customer.serviceRequests.map((request) => (
                <li key={request.id} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={request.status} />
                    <span className="text-muted-foreground">
                      {formatDate(request.createdAt)}
                    </span>
                  </div>
                  <p>{request.description || request.summary || "No description"}</p>
                </li>
              ))}
            </ul>
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
            <ul className="space-y-3">
              {customer.estimates.map((estimate) => (
                <li
                  key={estimate.id}
                  className="flex flex-wrap items-center justify-between gap-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={estimate.status} />
                    <span>{formatMoney(estimate.total)}</span>
                    <span className="text-muted-foreground">
                      {formatDate(estimate.createdAt)}
                    </span>
                  </div>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/estimates/${estimate.id}`}>Open</Link>
                  </Button>
                </li>
              ))}
            </ul>
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
            <ul className="space-y-3">
              {customer.jobs.map((job) => (
                <li
                  key={job.id}
                  className="flex flex-wrap items-center justify-between gap-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={job.status} />
                    <span className="text-muted-foreground">
                      {job.scheduledAt
                        ? formatDateTime(job.scheduledAt)
                        : formatDate(job.createdAt)}
                    </span>
                  </div>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/jobs/${job.id}`}>Open</Link>
                  </Button>
                </li>
              ))}
            </ul>
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
            <ul className="space-y-3">
              {customer.invoices.map((invoice) => (
                <li
                  key={invoice.id}
                  className="flex flex-wrap items-center justify-between gap-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={invoice.status} />
                    <span>{formatMoney(invoice.total)}</span>
                    <span className="text-muted-foreground">
                      {formatDate(invoice.createdAt)}
                    </span>
                  </div>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/invoices/${invoice.id}`}>Open</Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

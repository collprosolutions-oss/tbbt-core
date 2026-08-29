import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireManagementPageAccess } from "@/lib/access";
import { formatAddress, formatDate, latestDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Customers",
};

export default async function CustomersPage() {
  const access = await requireManagementPageAccess();
  const customers = await prisma.customer.findMany({
    where: access.scope,
    include: {
      properties: {
        select: {
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
        },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
      serviceRequests: {
        select: { createdAt: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
      estimates: {
        select: { createdAt: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
      jobs: {
        select: { createdAt: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
      invoices: {
        select: { createdAt: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
      _count: {
        select: {
          serviceRequests: true,
          jobs: true,
        },
      },
    },
    orderBy: { name: "asc" },
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Customers"
        description={`Customers for ${access.workspace.business.name}.`}
      />

      {customers.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No customers yet</CardTitle>
            <CardDescription>
              Customers appear here when someone submits a service request.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm">
              <Link href="/requests">Open requests</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {customers.map((customer) => {
            const activity = latestDate([
              customer.updatedAt,
              customer.createdAt,
              customer.serviceRequests[0]?.updatedAt,
              customer.serviceRequests[0]?.createdAt,
              customer.estimates[0]?.updatedAt,
              customer.estimates[0]?.createdAt,
              customer.jobs[0]?.updatedAt,
              customer.jobs[0]?.createdAt,
              customer.invoices[0]?.updatedAt,
              customer.invoices[0]?.createdAt,
            ]);
            const address = customer.properties[0]
              ? formatAddress(customer.properties[0])
              : null;

            return (
              <Card key={customer.id}>
                <CardHeader>
                  <CardTitle>{customer.name}</CardTitle>
                  <CardDescription>
                    {activity ? formatDate(activity) : "No activity yet"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p>Phone: {customer.phone || "None"}</p>
                  <p>Email: {customer.email || "None"}</p>
                  <p>Address: {address || "None"}</p>
                  <p>
                    {customer._count.serviceRequests} request
                    {customer._count.serviceRequests === 1 ? "" : "s"} ·{" "}
                    {customer._count.jobs} job
                    {customer._count.jobs === 1 ? "" : "s"}
                  </p>
                  <div className="pt-1">
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/customers/${customer.id}`}>Open</Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

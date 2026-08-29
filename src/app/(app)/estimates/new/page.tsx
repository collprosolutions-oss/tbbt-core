import type { Metadata } from "next";
import Link from "next/link";
import { CreateManualEstimateForm } from "@/components/estimates/create-manual-estimate-form";
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
import { formatAddress } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Create estimate",
};

export default async function NewManualEstimatePage() {
  const access = await requireManagementPageAccess();
  const customers = await prisma.customer.findMany({
    where: access.scope,
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      properties: {
        select: {
          id: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { name: "asc" },
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Create estimate"
        description="Start a draft for an existing or new customer. No service request is required."
      >
        <Button asChild size="sm" variant="outline">
          <Link href="/estimates">Back to estimates</Link>
        </Button>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Customer</CardTitle>
          <CardDescription>
            Choose a customer in this workspace or add one. Matching email or
            phone reuses the existing customer. Pick the service address that
            should be used if this estimate becomes a job. A request is not
            created.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateManualEstimateForm
            customers={customers.map((customer) => ({
              id: customer.id,
              name: customer.name,
              phone: customer.phone,
              email: customer.email,
              properties: customer.properties.map((property) => ({
                id: property.id,
                label: formatAddress(property),
              })),
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}

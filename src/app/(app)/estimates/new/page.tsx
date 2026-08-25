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
import { requireBusinessAccess } from "@/lib/access";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Create estimate",
};

export default async function NewManualEstimatePage() {
  const access = await requireBusinessAccess();
  const customers = await prisma.customer.findMany({
    where: access.scope,
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
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
            phone reuses the existing customer. A request is not created.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateManualEstimateForm customers={customers} />
        </CardContent>
      </Card>
    </div>
  );
}

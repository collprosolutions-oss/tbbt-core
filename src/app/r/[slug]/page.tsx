import type { Metadata } from "next";
import { ServiceRequestForm } from "@/components/intake/service-request-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { groupServicesByStarterCategory } from "@/lib/handyman-starter-catalog";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Request service",
};

export default async function PublicIntakePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const business = await prisma.business.findUnique({
    where: { slug: slug.trim().toLowerCase() },
    select: { id: true, name: true, slug: true },
  });

  if (!business) {
    return (
      <main className="flex min-h-full items-center justify-center px-4 py-10">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Request unavailable</CardTitle>
            <CardDescription>This request could not be submitted.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  // Only name + id are ever sent to the public form. Pricing, descriptions,
  // and inactive services stay owner-only.
  const activeServices = await prisma.serviceCatalogItem.findMany({
    where: { businessId: business.id, active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const groupedServices = groupServicesByStarterCategory(activeServices);

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Request a handyman</CardTitle>
          <CardDescription>{business.name}</CardDescription>
        </CardHeader>
        <CardContent>
          <ServiceRequestForm
            slug={business.slug}
            businessName={business.name}
            groupedServices={groupedServices}
          />
        </CardContent>
      </Card>
    </main>
  );
}

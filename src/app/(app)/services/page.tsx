import type { Metadata } from "next";
import { CatalogItemRow } from "@/components/catalog/catalog-item-row";
import { CreateCatalogItemForm } from "@/components/catalog/create-catalog-item-form";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireBusinessAccess } from "@/lib/access";
import { formatMoney } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Services",
};

export default async function ServicesPage() {
  const access = await requireBusinessAccess();
  const items = await prisma.serviceCatalogItem.findMany({
    where: access.scope,
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Services"
        description={`Handyman price list for ${access.workspace.business.name}. These are starting prices. An estimate can still be adjusted for the actual job.`}
      />

      <Card>
        <CardHeader>
          <CardTitle>Add service</CardTitle>
          <CardDescription>
            Name and starting price are required. Changing a price later does
            not change amounts already on estimates, jobs, or invoices.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateCatalogItemForm />
        </CardContent>
      </Card>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No services yet</CardTitle>
            <CardDescription>
              Add a service to start this workspace price list. Active services
              can be added to estimates.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <Card key={item.id}>
              <CardContent className="pt-4">
                <CatalogItemRow
                  id={item.id}
                  name={item.name}
                  price={item.price.toString()}
                  displayPrice={formatMoney(item.price)}
                  description={item.description ?? ""}
                  active={item.active}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

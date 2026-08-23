import type { Metadata } from "next";
import { CatalogItemRow } from "@/components/catalog/catalog-item-row";
import { CreateCatalogItemForm } from "@/components/catalog/create-catalog-item-form";
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
  title: "Services",
};

export default async function ServicesPage() {
  const access = await requireBusinessAccess();
  const items = await prisma.serviceCatalogItem.findMany({
    where: access.scope,
    orderBy: { name: "asc" },
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Services</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Price list for {access.workspace.business.name}.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add service</CardTitle>
          <CardDescription>Name and price are required.</CardDescription>
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
              Add a service to start this workspace price list.
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

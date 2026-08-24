import type { Metadata } from "next";
import { CatalogItemRow } from "@/components/catalog/catalog-item-row";
import { CreateCatalogItemForm } from "@/components/catalog/create-catalog-item-form";
import { InstallStarterCatalogForm } from "@/components/catalog/install-starter-catalog-form";
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
import { planStarterCatalogInstall } from "@/lib/handyman-starter-catalog";
import { prisma } from "@/lib/prisma";
import { isActiveTrade } from "@/lib/trades";

export const metadata: Metadata = {
  title: "Services",
};

export default async function ServicesPage() {
  const access = await requireBusinessAccess();
  const items = await prisma.serviceCatalogItem.findMany({
    where: access.scope,
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  const showStarterCatalog = isActiveTrade(access.workspace.business.tradeCode);
  const starterPlan = showStarterCatalog
    ? planStarterCatalogInstall(items.map((item) => item.name))
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Services"
        description={`Handyman price list for ${access.workspace.business.name}. These are starting prices. An estimate can still be adjusted for the actual job.`}
      />

      {starterPlan ? (
        <Card>
          <CardHeader>
            <CardTitle>Handyman starter catalog</CardTitle>
            <CardDescription>
              Copies starter services into this business only. Existing services
              are left unchanged. Catalog prices later do not change estimates
              already written.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <p className="font-medium">Will be added</p>
              {starterPlan.add.length === 0 ? (
                <p className="text-muted-foreground">
                  No new priced starter services to add.
                </p>
              ) : (
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {starterPlan.add.map((service) => (
                    <li key={service.templateKey}>
                      {service.name} — {formatMoney(service.startingPrice)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="font-medium">Already on your list (skipped)</p>
              {starterPlan.skip.length === 0 ? (
                <p className="text-muted-foreground">None yet.</p>
              ) : (
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {starterPlan.skip.map((service) => (
                    <li key={service.templateKey}>{service.name}</li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="font-medium">Not imported yet</p>
              <p className="text-muted-foreground">
                No approved starting price. These stay in the template until a
                price is set.
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {starterPlan.pending.map((service) => (
                  <li key={service.templateKey}>{service.name}</li>
                ))}
              </ul>
            </div>
            <InstallStarterCatalogForm />
          </CardContent>
        </Card>
      ) : null}

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

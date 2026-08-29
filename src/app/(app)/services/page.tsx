import type { Metadata } from "next";
import { CatalogItemRow } from "@/components/catalog/catalog-item-row";
import { CreateCatalogItemForm } from "@/components/catalog/create-catalog-item-form";
import { InstallStarterCatalogForm } from "@/components/catalog/install-starter-catalog-form";
import { ServiceCategoryGroup } from "@/components/catalog/service-category-group";
import { EmptyState } from "@/components/empty-state";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireManagementPageAccess } from "@/lib/access";
import {
  HANDYMAN_CATALOG_CATEGORIES,
  HANDYMAN_STARTER_SERVICES,
  isImportableStarterService,
  planStarterCatalogInstall,
  starterPricingMode,
} from "@/lib/handyman-starter-catalog";
import { formatCatalogPriceLabel } from "@/lib/pricing-mode";
import { prisma } from "@/lib/prisma";
import { groupServiceCatalogItemsByCategory } from "@/lib/service-catalog-category";
import { isActiveTrade } from "@/lib/trades";

export const metadata: Metadata = {
  title: "Services",
};

export default async function ServicesPage() {
  const access = await requireManagementPageAccess();
  const items = await prisma.serviceCatalogItem.findMany({
    where: access.scope,
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  const showStarterCatalog = isActiveTrade(access.workspace.business.tradeCode);
  const starterPlan = showStarterCatalog
    ? planStarterCatalogInstall(items.map((item) => item.name))
    : null;
  // Preferred display order for this business's trade. Handyman is the
  // only trade active today; a future trade would pass its own order (or
  // none) here instead -- this stays a page-level choice, not something
  // baked into the grouping helper itself.
  const preferredCategoryOrder = showStarterCatalog
    ? HANDYMAN_CATALOG_CATEGORIES
    : [];
  // Grouped by each item's OWN persisted `category` column -- no more
  // name-derived/hardcoded matching for the business's real catalog.
  const groupedItems = groupServiceCatalogItemsByCategory(
    items,
    preferredCategoryOrder,
  );
  const groupedStarter = showStarterCatalog
    ? groupServiceCatalogItemsByCategory(
        HANDYMAN_STARTER_SERVICES,
        preferredCategoryOrder,
      )
    : [];
  const skipKeys = new Set(
    (starterPlan?.skip ?? []).map((service) => service.templateKey),
  );
  const pendingKeys = new Set(
    (starterPlan?.pending ?? []).map((service) => service.templateKey),
  );
  // Category suggestions offered on the Add/Edit service forms: this
  // business's own categories already in use, plus (for Handyman) the
  // starter set as recommendations. Never a hardcoded global list.
  const suggestedCategories = Array.from(
    new Set([
      ...preferredCategoryOrder,
      ...items.map((item) => item.category),
    ]),
  ).sort((a, b) => a.localeCompare(b));

  return (
    <PageContainer>
      <PageHeader
        title="Services"
        description={`Handyman price list for ${access.workspace.business.name}. Each service can be a fixed price, a starting price, or a custom quote.`}
      />

      {starterPlan ? (
        <Card>
          <CardHeader>
            <CardTitle>Handyman starter catalog</CardTitle>
            <CardDescription>
              Template recommendations for this business only. Import copies
              them once. Re-importing skips names already on your list and does
              not change your prices, pricing mode, descriptions, or active
              status.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              {starterPlan.add.length} will be added. {starterPlan.skip.length}{" "}
              already on your list.
              {starterPlan.pending.length > 0
                ? ` ${starterPlan.pending.length} are not importable yet.`
                : null}
            </p>
            <div className="space-y-3">
              {groupedStarter.map((group) => (
                <ServiceCategoryGroup
                  key={`starter-${group.category}`}
                  category={group.category}
                  count={group.items.length}
                >
                  <ul className="space-y-2">
                    {group.items.map((service) => {
                      const status = skipKeys.has(service.templateKey)
                        ? "Already on your list"
                        : pendingKeys.has(service.templateKey) ||
                            !isImportableStarterService(service)
                          ? "Not imported yet"
                          : "Will be added";
                      return (
                        <li key={service.templateKey}>
                          <p className="font-medium">{service.name}</p>
                          <p className="text-muted-foreground">
                            {formatCatalogPriceLabel(
                              starterPricingMode(service),
                              service.startingPrice,
                            )}
                            {" · "}
                            {status}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                </ServiceCategoryGroup>
              ))}
            </div>
            <InstallStarterCatalogForm />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Add service</CardTitle>
          <CardDescription>
            Choose Fixed, Starting at, or Custom Quote. Changing a saved service
            later does not change amounts already on estimates, jobs, or
            invoices.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateCatalogItemForm categories={suggestedCategories} />
        </CardContent>
      </Card>

      <div className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Your Services & Pricing
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            These are the services and prices your business currently uses. You
            can edit pricing, descriptions, pricing mode, and active status at
            any time.
          </p>
        </div>
        {items.length === 0 ? (
          <EmptyState
            title="No services yet"
            description="Add a service to start this workspace price list. Active services can be added to estimates."
          />
        ) : (
          groupedItems.map((group) => (
            <ServiceCategoryGroup
              key={group.category}
              category={group.category}
              count={group.items.length}
            >
              {group.items.map((item) => (
                <Card key={item.id} className="shadow-none">
                  <CardContent className="pt-4">
                    <CatalogItemRow
                      id={item.id}
                      name={item.name}
                      pricingMode={item.pricingMode}
                      price={item.price?.toString() ?? ""}
                      displayPrice={formatCatalogPriceLabel(
                        item.pricingMode,
                        item.price,
                      )}
                      description={item.description ?? ""}
                      category={item.category}
                      categories={suggestedCategories}
                      active={item.active}
                    />
                  </CardContent>
                </Card>
              ))}
            </ServiceCategoryGroup>
          ))
        )}
      </div>
    </PageContainer>
  );
}

import type { Metadata } from "next";
import { ServicesWorkspace } from "@/components/services/services-workspace";
import type { ServiceCatalogListItem } from "@/components/services/types";
import { FounderDesignRoot } from "@/components/founder-design/root";
import { KpiCardsLayout } from "@/components/founder-design/kpi-cards-layout";
import { FounderRegion } from "@/components/founder-design/region";
import { TunableKpiCard } from "@/components/founder-design/tunable-kpi-card";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { checkFounderAccess } from "@/lib/founder-access";
import { sanitizeFounderPageTokens } from "@/lib/founder-design";
import { formatMoney } from "@/lib/format";
import {
  HANDYMAN_CATALOG_CATEGORIES,
  planStarterCatalogInstall,
} from "@/lib/handyman-starter-catalog";
import { formatCatalogPriceLabel } from "@/lib/pricing-mode";
import { prisma } from "@/lib/prisma";
import { groupServiceCatalogItemsByCategory } from "@/lib/service-catalog-category";
import { isActiveTrade } from "@/lib/trades";

export const metadata: Metadata = {
  title: "Services",
};

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<{ service?: string }>;
}) {
  const access = await requireManagementPageAccess();
  const params = await searchParams;

  const founder = await checkFounderAccess();
  const founderOverride = founder
    ? await prisma.founderDesignOverride.findUnique({
        where: { userId_pageKey: { userId: founder.id, pageKey: "services" } },
      })
    : null;
  const founderTokens = sanitizeFounderPageTokens(
    "services",
    founderOverride?.tokens ?? {},
  );

  const items = await prisma.serviceCatalogItem.findMany({
    where: access.scope,
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  const showStarterCatalog = isActiveTrade(access.workspace.business.tradeCode);
  const starterPlan = showStarterCatalog
    ? planStarterCatalogInstall(items.map((item) => item.name))
    : null;
  const preferredCategoryOrder = showStarterCatalog
    ? HANDYMAN_CATALOG_CATEGORIES
    : [];
  const groupedItems = groupServiceCatalogItemsByCategory(
    items,
    preferredCategoryOrder,
  );
  const suggestedCategories = Array.from(
    new Set([
      ...preferredCategoryOrder,
      ...items.map((item) => item.category),
    ]),
  ).sort((a, b) => a.localeCompare(b));

  const catalogItems: ServiceCatalogListItem[] = items.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description ?? "",
    pricingMode: item.pricingMode,
    price: item.price?.toString() ?? "",
    displayPrice: formatCatalogPriceLabel(item.pricingMode, item.price),
    category: item.category,
    active: item.active,
  }));

  const totalCount = items.length;
  const activeCount = items.filter((item) => item.active).length;
  const inactiveCount = totalCount - activeCount;
  const categoryCount = groupedItems.length;
  const fixedCount = items.filter((item) => item.pricingMode === "FIXED").length;
  const startingAtCount = items.filter(
    (item) => item.pricingMode === "STARTING_AT",
  ).length;
  const customQuoteCount = items.filter(
    (item) => item.pricingMode === "CUSTOM_QUOTE",
  ).length;

  const business = access.workspace.business;
  const laborMinimum = {
    enabled: business.laborMinimumEnabled,
    amountLabel:
      business.laborMinimumEnabled && business.laborMinimumAmount != null
        ? formatMoney(business.laborMinimumAmount)
        : null,
  };

  const kpis = [
    {
      label: "Total Services",
      value: totalCount,
      sublabel: `${fixedCount} fixed · ${startingAtCount} starting at · ${customQuoteCount} custom quote`,
      defaultIconId: "wrench" as const,
    },
    {
      label: "Active",
      value: activeCount,
      sublabel:
        totalCount > 0
          ? `${Math.round((activeCount / totalCount) * 100)}% of catalog`
          : "None yet",
      defaultIconId: "check-circle" as const,
    },
    {
      label: "Inactive",
      value: inactiveCount,
      sublabel: "Not offered on new estimates",
      defaultIconId: "clock" as const,
    },
    {
      label: "Categories",
      value: categoryCount,
      sublabel: "From persisted service categories",
      defaultIconId: "clipboard-list" as const,
    },
  ];

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Services"
        description={`Operating catalog for ${business.name}. Customer-facing wording, internal pricing, and the persisted service list.`}
      />

      <FounderDesignRoot
        pageKey="services"
        isFounder={Boolean(founder)}
        savedTokens={founderTokens}
        kpiCardLabels={kpis.map((kpi) => kpi.label)}
      >
        <FounderRegion id="kpi">
          <KpiCardsLayout
            gridClassName="grid-cols-2 lg:grid-cols-4"
            defaultGapPx={20}
          >
            {kpis.map((kpi, index) => (
              <TunableKpiCard
                key={kpi.label}
                index={index}
                label={kpi.label}
                value={kpi.value}
                sublabel={kpi.sublabel}
                defaultIconId={kpi.defaultIconId}
                variant="workspace"
                pageKey="services"
              />
            ))}
          </KpiCardsLayout>
        </FounderRegion>

        <ServicesWorkspace
          items={catalogItems}
          preferredCategoryOrder={preferredCategoryOrder}
          categories={suggestedCategories}
          laborMinimum={laborMinimum}
          businessName={business.name}
          publicRequestHref={`/r/${business.slug}`}
          starterPlan={
            starterPlan
              ? {
                  addCount: starterPlan.add.length,
                  skipCount: starterPlan.skip.length,
                  pendingCount: starterPlan.pending.length,
                }
              : null
          }
          initialServiceId={params.service}
        />
      </FounderDesignRoot>
    </PageContainer>
  );
}

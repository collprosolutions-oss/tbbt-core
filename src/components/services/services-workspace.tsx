"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { AddServiceSheet } from "@/components/services/add-service-sheet";
import { ServiceCatalogPanel } from "@/components/services/service-catalog-panel";
import { ServicePresentationPanel } from "@/components/services/service-presentation-panel";
import { ServicePricingPanel } from "@/components/services/service-pricing-panel";
import type {
  ActiveCatalogTradeOption,
  LaborMinimumSummary,
  ServiceCatalogListItem,
  TradeStarterCatalogPlan,
} from "@/components/services/types";
import { FounderRegion } from "@/components/founder-design/region";
import { PageHeaderControls } from "@/components/page-header-controls";
import { Button } from "@/components/ui/button";
import { SERVICE_CATALOG_IMPORT_ROUTE } from "@/lib/service-catalog-import-copy";

function pickInitialServiceId(
  items: ServiceCatalogListItem[],
  requestedId?: string,
) {
  if (requestedId && items.some((item) => item.id === requestedId)) {
    return requestedId;
  }
  const ceilingFan = items.find(
    (item) => item.name === "Ceiling Fan Replacement",
  );
  if (ceilingFan) return ceilingFan.id;
  const active = items.find((item) => item.active);
  return active?.id ?? items[0]?.id ?? null;
}

export function ServicesWorkspace({
  items,
  preferredCategoryOrder,
  categories,
  laborMinimum,
  businessName,
  publicRequestHref,
  starterPlans = [],
  activeTrades = [],
  initialServiceId,
  canImportCatalog = false,
}: {
  items: ServiceCatalogListItem[];
  preferredCategoryOrder: readonly string[];
  categories: string[];
  laborMinimum: LaborMinimumSummary;
  businessName: string;
  publicRequestHref: string;
  starterPlans?: TradeStarterCatalogPlan[];
  activeTrades?: ActiveCatalogTradeOption[];
  initialServiceId?: string;
  canImportCatalog?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    pickInitialServiceId(items, initialServiceId),
  );
  const [addOpen, setAddOpen] = useState(false);

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );

  return (
    <>
      <PageHeaderControls
        title="Services"
        actions={
          <div className="flex items-center gap-2">
            {canImportCatalog ? (
              <Button asChild size="sm" variant="outline">
                <Link href={SERVICE_CATALOG_IMPORT_ROUTE}>Import CSV</Link>
              </Button>
            ) : null}
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" />
              Add Service
            </Button>
          </div>
        }
      />

      <div
        data-services-workspace=""
        data-selected-service={selected?.id ?? ""}
        className="flex min-w-0 flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(16rem,var(--tbbt-panel-width,340px))_minmax(0,1fr)]"
      >
        <FounderRegion
          id="presentation"
          className="min-h-[22rem] min-w-0 lg:min-h-[36rem]"
        >
          <ServicePresentationPanel
            service={selected}
            businessName={businessName}
            publicRequestHref={publicRequestHref}
          />
        </FounderRegion>

        <FounderRegion
          id="catalog"
          className="order-first min-h-[22rem] min-w-0 lg:order-none lg:min-h-[36rem]"
        >
          <ServiceCatalogPanel
            items={items}
            preferredCategoryOrder={preferredCategoryOrder}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </FounderRegion>

        <FounderRegion
          id="pricing"
          className="min-h-[22rem] min-w-0 lg:min-h-[36rem]"
        >
          <ServicePricingPanel
            service={selected}
            categories={categories}
            laborMinimum={laborMinimum}
          />
        </FounderRegion>
      </div>

      <AddServiceSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        categories={categories}
        starterPlans={starterPlans}
        activeTrades={activeTrades}
      />
    </>
  );
}

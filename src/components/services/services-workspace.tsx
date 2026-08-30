"use client";

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { AddServiceSheet } from "@/components/services/add-service-sheet";
import { ServiceCatalogPanel } from "@/components/services/service-catalog-panel";
import { ServicePresentationPanel } from "@/components/services/service-presentation-panel";
import { ServicePricingPanel } from "@/components/services/service-pricing-panel";
import type {
  LaborMinimumSummary,
  ServiceCatalogListItem,
  StarterCatalogSummary,
} from "@/components/services/types";
import { FounderRegion } from "@/components/founder-design/region";
import { PageHeaderControls } from "@/components/page-header-controls";
import { Button } from "@/components/ui/button";

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
  starterPlan,
  initialServiceId,
}: {
  items: ServiceCatalogListItem[];
  preferredCategoryOrder: readonly string[];
  categories: string[];
  laborMinimum: LaborMinimumSummary;
  businessName: string;
  publicRequestHref: string;
  starterPlan: StarterCatalogSummary | null;
  initialServiceId?: string;
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
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            Add Service
          </Button>
        }
      />

      <div
        data-services-workspace=""
        data-selected-service={selected?.id ?? ""}
        className="flex min-w-0 flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,340px)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_var(--tbbt-panel-width,340px)]"
      >
        <FounderRegion
          id="presentation"
          className="min-h-[22rem] min-w-0 xl:col-start-1 xl:min-h-[36rem]"
        >
          <ServicePresentationPanel
            service={selected}
            businessName={businessName}
            publicRequestHref={publicRequestHref}
          />
        </FounderRegion>

        <FounderRegion
          id="catalog"
          className="order-first min-h-[22rem] min-w-0 lg:order-none lg:row-span-2 xl:col-start-3 xl:row-span-1 xl:min-h-[36rem]"
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
          className="min-h-[22rem] min-w-0 xl:col-start-2 xl:min-h-[36rem]"
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
        starterPlan={starterPlan}
      />
    </>
  );
}

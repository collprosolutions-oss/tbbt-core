"use client";

import { CreateCatalogItemForm } from "@/components/catalog/create-catalog-item-form";
import { InstallStarterCatalogForm } from "@/components/catalog/install-starter-catalog-form";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type {
  ActiveCatalogTradeOption,
  TradeStarterCatalogPlan,
} from "@/components/services/types";

export function AddServiceSheet({
  open,
  onOpenChange,
  categories,
  starterPlans = [],
  activeTrades = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: string[];
  starterPlans?: TradeStarterCatalogPlan[];
  activeTrades?: ActiveCatalogTradeOption[];
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Add service</SheetTitle>
          <SheetDescription>
            Uses this business&apos;s existing catalog. Choose a pricing mode
            allowed for the active trade. Saving a service later does not change
            amounts already on estimates, jobs, or invoices.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-8 px-4 pb-6">
          <CreateCatalogItemForm
            categories={categories}
            activeTrades={activeTrades}
          />
          {starterPlans.map((plan) => (
            <div
              key={plan.code}
              className="space-y-3 border-t border-border/70 pt-6"
            >
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {plan.label}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Template recommendations for this business only. Import copies
                  them once. Re-importing skips names already on your list and
                  does not change your prices, pricing mode, descriptions, or
                  active status.
                </p>
              </div>
              <p className="text-sm text-muted-foreground">
                {plan.addCount} will be added. {plan.skipCount} already on your
                list.
                {plan.pendingCount > 0
                  ? ` ${plan.pendingCount} are not importable yet.`
                  : null}
              </p>
              <InstallStarterCatalogForm
                tradeCode={plan.code}
                label={plan.label}
              />
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

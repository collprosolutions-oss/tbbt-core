"use client";

import { useState } from "react";
import Link from "next/link";
import { CatalogItemRow } from "@/components/catalog/catalog-item-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { pricingModeDescription, pricingModeLabel } from "@/lib/pricing-mode";
import type {
  LaborMinimumSummary,
  ServiceCatalogListItem,
} from "@/components/services/types";

function parsePriceNumber(value: string) {
  if (!value) return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function parseMoneyNumber(label: string | null) {
  if (!label) return null;
  const amount = Number(label.replace(/[^0-9.]/g, ""));
  return Number.isFinite(amount) ? amount : null;
}

export function ServicePricingPanel({
  service,
  categories,
  laborMinimum,
}: {
  service: ServiceCatalogListItem | null;
  categories: string[];
  laborMinimum: LaborMinimumSummary;
}) {
  const [editing, setEditing] = useState(false);

  const servicePrice = service ? parsePriceNumber(service.price) : null;
  const minimumAmount = parseMoneyNumber(laborMinimum.amountLabel);
  const belowMinimum =
    service != null &&
    laborMinimum.enabled &&
    servicePrice != null &&
    minimumAmount != null &&
    service.pricingMode !== "CUSTOM_QUOTE" &&
    servicePrice < minimumAmount;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/40">
      <div className="border-b border-border/70 p-4">
        <h2 className="text-base font-semibold text-foreground">
          Pricing Intelligence
        </h2>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {service?.name ?? "Select a service from the catalog"}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {!service ? (
          <p className="text-sm text-muted-foreground">
            Choose a service in the catalog to review its pricing mode and labor
            minimum behavior.
          </p>
        ) : (
          <>
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    Your price
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                    {service.displayPrice}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {pricingModeLabel(service.pricingMode)} ·{" "}
                    {pricingModeDescription(service.pricingMode)}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={editing ? "outline" : "default"}
                  onClick={() => setEditing((current) => !current)}
                >
                  {editing ? "Done" : "Edit"}
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{pricingModeLabel(service.pricingMode)}</Badge>
                <Badge variant="outline">{service.category}</Badge>
                <Badge variant={service.active ? "secondary" : "outline"}>
                  {service.active ? "Active" : "Inactive"}
                </Badge>
              </div>
            </div>

            <div className="space-y-2 rounded-lg border border-border/70 bg-background/50 p-4">
              <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Labor minimum
              </p>
              {laborMinimum.enabled && laborMinimum.amountLabel ? (
                <>
                  <p className="text-sm font-medium text-foreground">
                    This business applies a labor minimum of {laborMinimum.amountLabel}{" "}
                    on estimates.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Catalog prices are current guidance only. Historical estimate,
                    job, and invoice amounts stay as recorded. When this service is
                    added as a labor line and the estimate&apos;s labor subtotal is
                    below the minimum, the difference is added on that estimate.
                  </p>
                  {belowMinimum ? (
                    <p className="text-sm text-muted-foreground">
                      {service.displayPrice} is below this business&apos;s{" "}
                      {laborMinimum.amountLabel} labor minimum, so an estimate whose
                      labor lines total less than {laborMinimum.amountLabel} will
                      still apply the minimum.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Labor minimum is not enabled for this business. Enable it in
                  Business Settings if estimates should raise labor lines to a
                  minimum amount.
                </p>
              )}
              <Button asChild size="sm" variant="outline">
                <Link href="/settings">Business Settings</Link>
              </Button>
            </div>

            <div className="space-y-3 rounded-lg border border-dashed border-border/80 bg-muted/20 p-4">
              <div>
                <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Market Intelligence
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Market Comparison
                </p>
                <p className="text-sm text-muted-foreground">Not connected yet</p>
              </div>
              <dl className="space-y-2 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">Local Market</dt>
                  <dd className="text-right text-muted-foreground">Not available yet</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">State Market</dt>
                  <dd className="text-right text-muted-foreground">Not available yet</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">National Market</dt>
                  <dd className="text-right text-muted-foreground">Not available yet</dd>
                </div>
              </dl>
              <div>
                <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Market Position
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Not available until pricing intelligence is connected
                </p>
              </div>
            </div>

            {editing ? (
              <div className="rounded-lg border border-border/70 p-4">
                <CatalogItemRow
                  id={service.id}
                  name={service.name}
                  pricingMode={service.pricingMode}
                  price={service.price}
                  displayPrice={service.displayPrice}
                  description={service.description}
                  category={service.category}
                  categories={categories}
                  active={service.active}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { pricingModeLabel } from "@/lib/pricing-mode";
import type { ServiceCatalogListItem } from "@/components/services/types";

export function ServicePresentationPanel({
  service,
  businessName,
  publicRequestHref,
}: {
  service: ServiceCatalogListItem | null;
  businessName: string;
  publicRequestHref: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/40">
      <div className="border-b border-border/70 p-4">
        <h2 className="text-base font-semibold text-foreground">
          Service Presentation
        </h2>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {service?.name ?? "Select a service from the catalog"}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {!service ? (
          <p className="text-sm text-muted-foreground">
            Choose a service in the catalog to see its customer-facing wording.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-lg font-semibold text-foreground">{service.name}</p>
                <Badge variant={service.active ? "secondary" : "outline"}>
                  {service.active ? "Active" : "Inactive"}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {service.category} · {pricingModeLabel(service.pricingMode)}
              </p>
            </div>

            <div className="rounded-lg border border-border/70 bg-background/50 p-4">
              <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Customer-facing wording
              </p>
              <p className="mt-2 text-base font-medium text-foreground">
                {service.name}
              </p>
              <p className="mt-1 text-sm font-semibold text-primary">
                {service.displayPrice}
              </p>
              {service.description ? (
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {service.description}
                </p>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  No description saved for this service yet.
                </p>
              )}
              <div className="mt-4">
                <span className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground">
                  Request Estimate
                </span>
              </div>
            </div>

            <div className="space-y-2 rounded-lg border border-dashed border-border/80 bg-muted/20 p-4">
              <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Public website
              </p>
              <p className="text-sm text-muted-foreground">
                Website publishing is not connected yet. This panel does not
                publish, hide, or change a public site. Active services already
                appear on {businessName}&apos;s public request form.
              </p>
              <Button asChild size="sm" variant="outline">
                <Link href={publicRequestHref}>Open public request form</Link>
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

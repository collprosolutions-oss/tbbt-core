"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ServicePicker,
  type SelectedWorkState,
} from "@/components/public/service-picker";
import { Button } from "@/components/ui/button";
import type { PublicCatalogGroup, PublicCatalogItem } from "@/lib/public-site";

export function HomeCatalogContinue({
  slug,
  items,
  groups,
}: {
  slug: string;
  items: PublicCatalogItem[];
  groups: PublicCatalogGroup[];
}) {
  const [selected, setSelected] = useState<SelectedWorkState>({
    catalogIds: [],
    includeOther: false,
    otherDescription: "",
  });

  const params = new URLSearchParams();
  if (selected.catalogIds.length > 0) {
    params.set("services", selected.catalogIds.join(","));
  }
  if (selected.includeOther) {
    params.set("other", "1");
    if (selected.otherDescription.trim()) {
      params.set("otherText", selected.otherDescription.trim());
    }
  }
  const query = params.toString();
  const href = query ? `/r/${slug}?${query}` : `/r/${slug}`;
  const canContinue =
    selected.catalogIds.length > 0 || selected.includeOther;

  return (
    <div className="space-y-5">
      <ServicePicker
        groups={groups}
        items={items}
        selected={selected}
        onChange={setSelected}
      />
      {canContinue ? (
        <Button asChild className="h-12 w-full px-5 text-base sm:w-auto">
          <Link href={href}>Continue to request</Link>
        </Button>
      ) : (
        <Button type="button" className="h-12 w-full px-5 text-base sm:w-auto" disabled>
          Select work to continue
        </Button>
      )}
    </div>
  );
}

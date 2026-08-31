"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ServicePicker,
  type SelectedWorkState,
} from "@/components/public/service-picker";
import type { PublicCatalogGroup, PublicCatalogItem } from "@/lib/public-site";

export function HomeCatalogContinue({
  slug,
  items,
  groups,
  initialCategory,
}: {
  slug: string;
  items: PublicCatalogItem[];
  groups: PublicCatalogGroup[];
  initialCategory?: string;
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
        initialCategory={initialCategory}
      />
      {canContinue ? (
        <Link href={href} className="public-btn public-btn-primary w-full sm:w-auto">
          Continue to request
        </Link>
      ) : (
        <button type="button" className="public-btn public-btn-outline w-full sm:w-auto" disabled>
          Select work to continue
        </button>
      )}
    </div>
  );
}

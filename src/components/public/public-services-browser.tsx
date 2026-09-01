"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { CategoryCards } from "@/components/public/category-cards";
import { HomeCatalogContinue } from "@/components/public/home-catalog-continue";
import { PUBLIC_PRICING_DISCLAIMER, popularPublicCategories } from "@/lib/public-site";
import type { PublicCatalogGroup, PublicCatalogItem } from "@/lib/public-site";

export function PublicServicesBrowser({
  slug,
  items,
  groups,
  servicesHref,
  initialCategory,
}: {
  slug: string;
  items: PublicCatalogItem[];
  groups: PublicCatalogGroup[];
  servicesHref: string;
  initialCategory?: string;
}) {
  const allCategories = popularPublicCategories(groups, groups.length);
  const starting =
    initialCategory && groups.some((group) => group.category === initialCategory)
      ? initialCategory
      : "all";
  const [active, setActive] = useState(starting);
  const [query, setQuery] = useState("");

  const visibleCategories = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allCategories.filter((category) => {
      if (active !== "all" && category.category !== active) return false;
      if (!q) return true;
      return (
        category.category.toLowerCase().includes(q) ||
        category.descriptor.toLowerCase().includes(q)
      );
    });
  }, [active, allCategories, query]);

  return (
    <div>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="public-chip-row">
          <button
            type="button"
            className="public-chip"
            data-active={active === "all" ? "true" : "false"}
            onClick={() => setActive("all")}
          >
            All Services
          </button>
          {allCategories.map((category) => (
            <button
              key={category.category}
              type="button"
              className="public-chip"
              data-active={active === category.category ? "true" : "false"}
              onClick={() => setActive(category.category)}
            >
              {category.category}
            </button>
          ))}
        </div>
        <div className="public-search w-full lg:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search services..."
            aria-label="Search services"
          />
        </div>
      </div>

      <div className="mt-8">
        <CategoryCards
          categories={visibleCategories}
          servicesHref={servicesHref}
          variant="services"
        />
      </div>

      <div id="select-work" className="mt-14 scroll-mt-28">
        <h3 className="text-2xl font-extrabold tracking-tight uppercase">
          Select Your Work
        </h3>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
          {PUBLIC_PRICING_DISCLAIMER}
        </p>
        <div className="mt-6">
          <HomeCatalogContinue
            key={active}
            slug={slug}
            items={items}
            groups={groups}
            initialCategory={active === "all" ? undefined : active}
          />
        </div>
      </div>
    </div>
  );
}

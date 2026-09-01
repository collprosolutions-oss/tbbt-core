"use client";

import { useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OTHER_TASK_LABEL } from "@/lib/service-request-work";
import type { PublicCatalogGroup, PublicCatalogItem } from "@/lib/public-site";
import { cn } from "@/lib/utils";

export type SelectedWorkState = {
  catalogIds: string[];
  includeOther: boolean;
  otherDescription: string;
};

export function selectedWorkLabels(
  selected: SelectedWorkState,
  items: PublicCatalogItem[],
) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const labels = selected.catalogIds
    .map((id) => byId.get(id)?.name)
    .filter((name): name is string => Boolean(name));
  if (selected.includeOther) {
    labels.push(selected.otherDescription.trim() || OTHER_TASK_LABEL);
  }
  return labels;
}

export function ServicePicker({
  groups,
  items,
  selected,
  onChange,
  searchId = "service-search",
  initialCategory,
}: {
  groups: PublicCatalogGroup[];
  items: PublicCatalogItem[];
  selected: SelectedWorkState;
  onChange: (next: SelectedWorkState) => void;
  searchId?: string;
  initialCategory?: string;
}) {
  const [query, setQuery] = useState("");
  const startingCategory =
    initialCategory && groups.some((group) => group.category === initialCategory)
      ? initialCategory
      : "all";
  const [activeCategory, setActiveCategory] = useState<string>(startingCategory);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .filter((group) => activeCategory === "all" || group.category === activeCategory)
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => {
          if (!q) return true;
          return (
            item.name.toLowerCase().includes(q) ||
            (item.description ?? "").toLowerCase().includes(q) ||
            item.category.toLowerCase().includes(q)
          );
        }),
      }))
      .filter((group) => group.items.length > 0);
  }, [activeCategory, groups, query]);

  function toggleCatalog(id: string) {
    const catalogIds = selected.catalogIds.includes(id)
      ? selected.catalogIds.filter((value) => value !== id)
      : [...selected.catalogIds, id];
    onChange({ ...selected, catalogIds });
  }

  function removeCatalog(id: string) {
    onChange({
      ...selected,
      catalogIds: selected.catalogIds.filter((value) => value !== id),
    });
  }

  const labels = selectedWorkLabels(selected, items);

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor={searchId}>Search services</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by job name"
            className="h-12 bg-white pl-10 text-base"
          />
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Service categories">
        <CategoryChip
          selected={activeCategory === "all"}
          onClick={() => setActiveCategory("all")}
        >
          All
        </CategoryChip>
        {groups.map((group) => (
          <CategoryChip
            key={group.category}
            selected={activeCategory === group.category}
            onClick={() => setActiveCategory(group.category)}
          >
            {group.category}
          </CategoryChip>
        ))}
      </div>

      <div className="space-y-6">
        {filteredGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No matching services. Try another search, or choose Other / Something Else.
          </p>
        ) : (
          filteredGroups.map((group) => (
            <section key={group.category} aria-labelledby={`category-${group.category}`}>
              <h3
                id={`category-${group.category}`}
                className="mb-3 text-lg font-semibold tracking-tight"
              >
                {group.category}
              </h3>
              <ul className="grid gap-4 sm:grid-cols-2">
                {group.items.map((item) => {
                  const checked = selected.catalogIds.includes(item.id);
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-pressed={checked}
                        onClick={() => toggleCatalog(item.id)}
                        className={cn(
                          "flex min-h-36 w-full flex-col rounded-2xl border p-5 text-left transition-colors",
                          checked
                            ? "border-[var(--public-blue)] bg-[#eaf1ff]"
                            : "border-border bg-white hover:border-[var(--public-blue)]/50",
                        )}
                      >
                        <span className="flex items-start justify-between gap-3">
                          <span className="text-lg font-semibold">{item.name}</span>
                          <span
                            className={cn(
                              "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border",
                              checked
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border bg-white",
                            )}
                            aria-hidden="true"
                          >
                            {checked ? <Check className="size-3.5" /> : null}
                          </span>
                        </span>
                        {item.description ? (
                          <span className="mt-2 line-clamp-3 text-base leading-6 text-muted-foreground">
                            {item.description}
                          </span>
                        ) : null}
                        <span className="mt-4 text-base font-semibold text-[var(--public-blue)]">
                          {item.priceLabel}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>

      <div>
        <button
          type="button"
          aria-pressed={selected.includeOther}
          onClick={() =>
            onChange({ ...selected, includeOther: !selected.includeOther })
          }
          className={cn(
            "flex w-full items-center justify-between rounded-xl border p-4 text-left",
            selected.includeOther
              ? "border-primary bg-accent"
              : "border-border bg-card hover:border-primary/40",
          )}
        >
          <span>
            <span className="block font-semibold">{OTHER_TASK_LABEL}</span>
            <span className="mt-1 block text-sm text-muted-foreground">
              Not sure of the service name? Describe the work in your own words.
            </span>
          </span>
          <span
            className={cn(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-full border",
              selected.includeOther
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-white",
            )}
            aria-hidden="true"
          >
            {selected.includeOther ? <Check className="size-3.5" /> : null}
          </span>
        </button>
        {selected.includeOther ? (
          <div className="mt-3 space-y-2">
            <Label htmlFor="otherDescription">Describe the other work</Label>
            <textarea
              id="otherDescription"
              name="otherDescription"
              value={selected.otherDescription}
              onChange={(event) =>
                onChange({ ...selected, otherDescription: event.target.value })
              }
              rows={3}
              className="w-full rounded-lg border border-input bg-white px-3 py-2 text-base"
              placeholder="What needs to be done?"
            />
          </div>
        ) : null}
      </div>

      <section
        aria-live="polite"
        className="rounded-xl border border-border bg-white p-4"
      >
        <h3 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          Selected Work ({labels.length})
        </h3>
        {labels.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No tasks selected yet.
          </p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {selected.catalogIds.map((id) => {
              const item = items.find((row) => row.id === id);
              if (!item) return null;
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => removeCatalog(id)}
                    className="inline-flex min-h-11 items-center gap-2 rounded-full bg-secondary px-3 py-2 text-sm font-medium"
                  >
                    {item.name}
                    <X className="size-4" aria-hidden="true" />
                    <span className="sr-only">Remove {item.name}</span>
                  </button>
                </li>
              );
            })}
            {selected.includeOther ? (
              <li>
                <button
                  type="button"
                  onClick={() =>
                    onChange({ ...selected, includeOther: false, otherDescription: "" })
                  }
                  className="inline-flex min-h-11 items-center gap-2 rounded-full bg-secondary px-3 py-2 text-sm font-medium"
                >
                  {selected.otherDescription.trim() || OTHER_TASK_LABEL}
                  <X className="size-4" aria-hidden="true" />
                  <span className="sr-only">Remove other task</span>
                </button>
              </li>
            ) : null}
          </ul>
        )}
      </section>
    </div>
  );
}

function CategoryChip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "public-chip",
        selected ? "public-chip-active" : "",
      )}
    >
      {children}
    </button>
  );
}

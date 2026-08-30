"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { groupServiceCatalogItemsByCategory } from "@/lib/service-catalog-category";
import { cn } from "@/lib/utils";
import type { ServiceCatalogListItem } from "@/components/services/types";

export function ServiceCatalogPanel({
  items,
  preferredCategoryOrder,
  selectedId,
  onSelect,
}: {
  items: ServiceCatalogListItem[];
  preferredCategoryOrder: readonly string[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const selected = items.find((item) => item.id === selectedId);
    const keep = selected?.category;
    return new Set(
      groupServiceCatalogItemsByCategory(items, preferredCategoryOrder)
        .map((group) => group.category)
        .filter((category) => category !== keep),
    );
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q),
    );
  }, [items, query]);

  const groups = useMemo(
    () => groupServiceCatalogItemsByCategory(filtered, preferredCategoryOrder),
    [filtered, preferredCategoryOrder],
  );

  const searching = query.trim().length > 0;
  const activeCount = items.filter((item) => item.active).length;

  useEffect(() => {
    const selected = items.find((item) => item.id === selectedId);
    if (!selected) return;
    setCollapsed((current) => {
      if (!current.has(selected.category)) return current;
      const next = new Set(current);
      next.delete(selected.category);
      return next;
    });
  }, [items, selectedId]);

  function expandAll() {
    setCollapsed(new Set());
  }

  function collapseAll() {
    setCollapsed(new Set(groups.map((group) => group.category)));
  }

  function toggleCategory(category: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/40">
      <div className="space-y-3 border-b border-border/70 p-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Service Catalog
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {activeCount} active · {groups.length}{" "}
            {groups.length === 1 ? "category" : "categories"}
            {searching ? ` · ${filtered.length} match${filtered.length === 1 ? "" : "es"}` : null}
          </p>
        </div>
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search services..."
          aria-label="Search services"
          className="h-9"
        />
        <div className="flex items-center justify-end gap-3 text-xs">
          <button
            type="button"
            onClick={collapseAll}
            className="font-medium text-muted-foreground hover:text-foreground"
          >
            Collapse All
          </button>
          <button
            type="button"
            onClick={expandAll}
            className="font-medium text-muted-foreground hover:text-foreground"
          >
            Expand All
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {items.length === 0
              ? "No services yet. Add a service to start this workspace price list."
              : "No services match that search."}
          </p>
        ) : (
          groups.map((group) => {
            const open = searching || !collapsed.has(group.category);
            return (
              <div key={group.category} className="border-b border-border/60 last:border-b-0">
                <button
                  type="button"
                  onClick={() => toggleCategory(group.category)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-accent/40"
                >
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {group.category}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    {group.items.length}
                    <ChevronDown
                      className={cn("size-3.5 transition-transform", open ? "rotate-0" : "-rotate-90")}
                    />
                  </span>
                </button>
                {open ? (
                  <ul className="pb-1">
                    {group.items.map((item) => {
                      const selected = item.id === selectedId;
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => onSelect(item.id)}
                            className={cn(
                              "flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm transition-colors",
                              selected
                                ? "bg-primary/15 text-primary"
                                : "text-foreground hover:bg-accent/40",
                            )}
                          >
                            <span className="min-w-0 truncate font-medium">{item.name}</span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              {item.active ? (
                                <Badge variant={selected ? "default" : "secondary"}>
                                  Active
                                </Badge>
                              ) : (
                                <Badge variant="outline">Inactive</Badge>
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

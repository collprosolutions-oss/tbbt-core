"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Check, ChevronDown } from "lucide-react";
import { OTHER_TASK_LABEL } from "@/lib/service-request-work";
import { PUBLIC_PRICING_DISCLAIMER, publicCategoryPhoto } from "@/lib/public-site";
import type { PublicCatalogGroup, PublicCatalogItem } from "@/lib/public-site";
import { cn } from "@/lib/utils";

export function PublicServicesBrowser({
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
  const starting =
    initialCategory && groups.some((group) => group.category === initialCategory)
      ? initialCategory
      : groups[0]?.category ?? "";
  const [active, setActive] = useState(starting);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [includeOther, setIncludeOther] = useState(false);
  const [otherText, setOtherText] = useState("");

  const group = groups.find((item) => item.category === active) ?? groups[0];
  const selectedLabels = useMemo(() => {
    const names = selected
      .map((id) => items.find((item) => item.id === id)?.name)
      .filter((name): name is string => Boolean(name));
    if (includeOther) names.push(otherText.trim() || OTHER_TASK_LABEL);
    return names;
  }, [includeOther, items, otherText, selected]);

  const params = new URLSearchParams();
  if (selected.length) params.set("services", selected.join(","));
  if (includeOther) {
    params.set("other", "1");
    if (otherText.trim()) params.set("otherText", otherText.trim());
  }
  const href = params.toString() ? `/r/${slug}?${params}` : `/r/${slug}`;

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  if (!group) {
    return <p>Services will appear here when the catalog is available.</p>;
  }

  return (
    <div className="public-services-layout">
      <aside className="public-cat-rail">
        <h2>Categories</h2>
        {groups.map((item) => (
          <button
            key={item.category}
            type="button"
            data-active={item.category === group.category ? "true" : "false"}
            onClick={() => {
              setActive(item.category);
              setOpenId(null);
            }}
          >
            {item.category}
          </button>
        ))}
      </aside>

      <div>
        <div className="relative mb-6 min-h-80 overflow-hidden rounded-md">
          <Image
            src={publicCategoryPhoto(group.category)}
            alt=""
            fill
            sizes="(max-width: 1100px) 100vw, 70vw"
            className="object-cover"
          />
        </div>
        <h2 className="text-3xl font-extrabold tracking-tight">{group.category}</h2>
        <p className="mt-3 max-w-3xl text-muted-foreground">
          {group.items.length} service{group.items.length === 1 ? "" : "s"} in this category.
          Select one or more tasks, then continue to request a quote.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{PUBLIC_PRICING_DISCLAIMER}</p>

        <div className="mt-6">
          {group.items.map((item) => {
            const checked = selected.includes(item.id);
            const expanded = openId === item.id;
            return (
              <div key={item.id} className="public-service-row">
                <div className="flex items-start justify-between gap-4">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setOpenId(expanded ? null : item.id)}
                  >
                    <strong>{item.name}</strong>
                    <span className="mt-1 block text-sm font-semibold">{item.priceLabel}</span>
                  </button>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-pressed={checked}
                      onClick={() => toggle(item.id)}
                      className={cn(
                        "inline-flex size-8 items-center justify-center rounded-full border",
                        checked
                          ? "border-[var(--public-blue)] bg-[var(--public-blue)] text-white"
                          : "border-[#d5dde6] bg-white",
                      )}
                    >
                      {checked ? <Check className="size-4" /> : null}
                      <span className="sr-only">Select {item.name}</span>
                    </button>
                    <button type="button" onClick={() => setOpenId(expanded ? null : item.id)}>
                      <ChevronDown className={cn("size-5 text-[var(--public-blue)]", expanded && "rotate-180")} />
                      <span className="sr-only">Details</span>
                    </button>
                  </div>
                </div>
                {expanded && item.description ? (
                  <p className="text-sm leading-6 text-muted-foreground">{item.description}</p>
                ) : null}
              </div>
            );
          })}
        </div>

        <button
          type="button"
          aria-pressed={includeOther}
          onClick={() => setIncludeOther((current) => !current)}
          className="public-service-row mt-2"
        >
          <strong>{OTHER_TASK_LABEL}</strong>
          <span className="text-sm text-muted-foreground">
            Not sure of the service name? Describe the work in your own words.
          </span>
        </button>
        {includeOther ? (
          <textarea
            className="mt-3 w-full rounded-md border px-3 py-2"
            rows={3}
            value={otherText}
            onChange={(event) => setOtherText(event.target.value)}
            placeholder="What needs to be done?"
          />
        ) : null}

        <section className="mt-6 rounded-md border bg-white p-4">
          <h3 className="text-sm font-extrabold tracking-wide uppercase">
            Selected Work ({selectedLabels.length})
          </h3>
          {selectedLabels.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No tasks selected yet.</p>
          ) : (
            <ul className="mt-3 flex flex-wrap gap-2">
              {selected.map((id) => {
                const item = items.find((row) => row.id === id);
                if (!item) return null;
                return (
                  <li key={id}>
                    <button type="button" className="public-chip" onClick={() => toggle(id)}>
                      {item.name} ×
                    </button>
                  </li>
                );
              })}
              {includeOther ? (
                <li>
                  <button type="button" className="public-chip" onClick={() => setIncludeOther(false)}>
                    {otherText.trim() || OTHER_TASK_LABEL} ×
                  </button>
                </li>
              ) : null}
            </ul>
          )}
        </section>

        {selected.length > 0 || includeOther ? (
          <Link href={href} className="public-btn public-btn-primary mt-6">
            Continue to request
          </Link>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">Select work to continue.</p>
        )}
      </div>
    </div>
  );
}

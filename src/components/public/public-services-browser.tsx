"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown } from "lucide-react";
import { PublicFittedImage } from "@/components/public/public-fitted-image";
import {
  OTHER_TASK_LABEL,
  coerceRequestQuantity,
  parseRequestQuantity,
} from "@/lib/service-request-work";
import { PUBLIC_PRICING_DISCLAIMER } from "@/lib/public-site";
import type { PublicCatalogGroup, PublicCatalogItem } from "@/lib/public-site";
import type { ResolvedPublicSiteImage } from "@/lib/public-site-images";
import {
  formatPricingSummaryLines,
  formatWorkQuantityLabel,
  quantityForId,
  selectedCatalogPricingRows,
  selectedWorkQuery,
  setSelectedQuantity,
  summarizeSelectedWorkPricing,
  toggleSelectedCatalog,
  type SelectedWorkState,
} from "@/lib/selected-work";
import { cn } from "@/lib/utils";

export function PublicServicesBrowser({
  slug,
  items,
  groups,
  initialCategory,
  initialSelected,
  categoryImages,
}: {
  slug: string;
  items: PublicCatalogItem[];
  groups: PublicCatalogGroup[];
  initialCategory?: string;
  initialSelected: SelectedWorkState;
  categoryImages: Record<string, ResolvedPublicSiteImage>;
}) {
  const starting =
    initialCategory && groups.some((group) => group.category === initialCategory)
      ? initialCategory
      : groups[0]?.category ?? "";
  const [active, setActive] = useState(starting);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedWorkState>(initialSelected);

  const group = groups.find((item) => item.category === active) ?? groups[0];
  const selectedRows = useMemo(
    () =>
      selected.catalogIds
        .map((id) => items.find((item) => item.id === id))
        .filter((item): item is PublicCatalogItem => Boolean(item)),
    [items, selected.catalogIds],
  );
  const selectedCount = selectedRows.length + (selected.includeOther ? 1 : 0);
  const href = `/r/${slug}${selectedWorkQuery(selected)}`;
  const summary = summarizeSelectedWorkPricing(
    selectedCatalogPricingRows(selected, items),
  );
  const summaryLines = formatPricingSummaryLines(summary);
  const categoryImage = group ? categoryImages[group.category] : null;

  function setQty(id: string, raw: string) {
    const parsed = parseRequestQuantity(raw);
    if (parsed == null && raw !== "") return;
    setSelected((current) => setSelectedQuantity(current, id, parsed ?? 1));
  }

  if (!group) {
    return <p>Services will appear here when the catalog is available.</p>;
  }

  return (
    <div className="public-services-layout">
      <aside>
        <div className="public-cat-rail">
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
        </div>
        <div className="public-selected-box">
          <h3>Selected Work ({selectedCount})</h3>
          {selectedCount === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Select one or more tasks to continue.
            </p>
          ) : (
            <ul>
              {selectedRows.map((item) => {
                const qty = quantityForId(selected.quantities, item.id);
                return (
                  <li key={item.id}>
                    <span>{formatWorkQuantityLabel(qty, item.name)}</span>
                    <span className="public-selected-actions">
                      <input
                        className="public-qty"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={99}
                        step={1}
                        value={qty}
                        aria-label={`Quantity for ${item.name}`}
                        onFocus={(event) => event.currentTarget.select()}
                        onChange={(event) => setQty(item.id, event.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setSelected((current) => toggleSelectedCatalog(current, item.id))
                        }
                        aria-label={`Remove ${item.name}`}
                      >
                        ×
                      </button>
                    </span>
                  </li>
                );
              })}
              {selected.includeOther ? (
                <li>
                  <span>
                    {formatWorkQuantityLabel(
                      selected.otherQuantity,
                      selected.otherDescription.trim() || OTHER_TASK_LABEL,
                    )}
                  </span>
                  <span className="public-selected-actions">
                    <input
                      className="public-qty"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={99}
                      step={1}
                      value={selected.otherQuantity}
                      aria-label="Quantity for other work"
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => {
                        const parsed = parseRequestQuantity(event.target.value);
                        if (parsed == null && event.target.value !== "") return;
                        setSelected((current) => ({
                          ...current,
                          otherQuantity: parsed ?? 1,
                        }));
                      }}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setSelected((current) => ({
                          ...current,
                          includeOther: false,
                          otherQuantity: 1,
                        }))
                      }
                      aria-label="Remove other work"
                    >
                      ×
                    </button>
                  </span>
                </li>
              ) : null}
            </ul>
          )}
          {summaryLines.length > 0 ? (
            <div className="public-estimate-summary">
              <h4>Estimated Project</h4>
              {summaryLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
              <p className="public-estimate-note">
                This is not a formal estimate. CollPro reviews the request before sending a written estimate.
              </p>
            </div>
          ) : null}
          {selectedCount > 0 ? (
            <Link href={href} className="public-btn public-btn-primary">
              Continue with Selected Work
            </Link>
          ) : null}
        </div>
      </aside>

      <div>
        {categoryImage ? (
          <div className="public-services-category-media relative mb-5 overflow-hidden rounded-md">
            <PublicFittedImage
              src={categoryImage.src}
              alt=""
              objectPosition={categoryImage.objectPosition}
              sizes="(max-width: 1100px) 100vw, 70vw"
            />
          </div>
        ) : null}
        <h2 className="text-3xl font-extrabold tracking-tight">{group.category}</h2>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          {group.items.length} service{group.items.length === 1 ? "" : "s"} in this category.
          Select the work you need and set a quantity, then continue to request a quote.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{PUBLIC_PRICING_DISCLAIMER}</p>

        <div className="public-service-options">
          {group.items.map((item) => {
            const checked = selected.catalogIds.includes(item.id);
            const expanded = openId === item.id;
            const qty = quantityForId(selected.quantities, item.id);
            return (
              <div key={item.id} className="public-service-row" data-selected={checked ? "true" : "false"}>
                <button
                  type="button"
                  className="public-service-copy"
                  onClick={() => setOpenId(expanded ? null : item.id)}
                >
                  <strong>{item.name}</strong>
                  <span>{item.priceLabel}</span>
                </button>
                <div className="public-service-controls">
                  <button
                    type="button"
                    aria-pressed={checked}
                    onClick={() => setSelected((current) => toggleSelectedCatalog(current, item.id))}
                    className={cn(
                      "public-select-control",
                      checked
                        ? "border-[var(--public-blue)] bg-[var(--public-blue)] text-white"
                        : "border-[#d5dde6] bg-white",
                    )}
                  >
                    {checked ? <Check className="size-4" /> : null}
                    <span className="sr-only">Select {item.name}</span>
                  </button>
                  <input
                    className="public-qty"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={99}
                    step={1}
                    value={checked ? qty : 1}
                    disabled={!checked}
                    aria-label={`Quantity for ${item.name}`}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => setQty(item.id, event.target.value)}
                  />
                  <button
                    type="button"
                    className="public-details-btn"
                    onClick={() => setOpenId(expanded ? null : item.id)}
                  >
                    <ChevronDown className={cn("size-5 text-[var(--public-blue)]", expanded && "rotate-180")} />
                    <span className="sr-only">Details</span>
                  </button>
                </div>
                {expanded && item.description ? (
                  <p className="public-service-details">{item.description}</p>
                ) : null}
              </div>
            );
          })}
        </div>

        <button
          type="button"
          aria-pressed={selected.includeOther}
          onClick={() =>
            setSelected((current) => ({
              ...current,
              includeOther: !current.includeOther,
              otherQuantity: current.includeOther
                ? 1
                : coerceRequestQuantity(current.otherQuantity, 1),
            }))
          }
          className="public-service-row public-service-other mt-2"
        >
          <strong>{OTHER_TASK_LABEL}</strong>
          <span className="text-sm text-muted-foreground">
            Not sure of the service name? Describe the work in your own words.
          </span>
        </button>
        {selected.includeOther ? (
          <div className="mt-3 flex flex-wrap items-start gap-3">
            <input
              className="public-qty"
              type="number"
              inputMode="numeric"
              min={1}
              max={99}
              step={1}
              value={selected.otherQuantity}
              aria-label="Quantity for other work"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                const parsed = parseRequestQuantity(event.target.value);
                if (parsed == null && event.target.value !== "") return;
                setSelected((current) => ({ ...current, otherQuantity: parsed ?? 1 }));
              }}
            />
            <textarea
              className="min-w-0 flex-1 rounded-md border px-3 py-2"
              rows={3}
              value={selected.otherDescription}
              onChange={(event) =>
                setSelected((current) => ({ ...current, otherDescription: event.target.value }))
              }
              placeholder="What needs to be done?"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

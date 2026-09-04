"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import {
  requestAdditionalWork,
  type RequestAdditionalWorkState,
} from "@/app/actions/public-additional-work-request";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { PublicCatalogItem } from "@/lib/public-site";
import { groupServiceCatalogItemsByCategory } from "@/lib/service-catalog-category";
import {
  OTHER_TASK_LABEL,
  parseRequestQuantity,
} from "@/lib/service-request-work";
import {
  emptySelectedWork,
  quantityForId,
  setSelectedQuantity,
  toggleSelectedCatalog,
} from "@/lib/selected-work";

const initialState: RequestAdditionalWorkState = {};

/**
 * "+ Request Additional Work" on the Customer Project Portal. This is NOT
 * approval and does NOT create a Change Order by itself -- it only sends
 * the business a request for them to review. Approved scope, price, Job
 * total, and the invoice are never changed by this alone.
 */
export function RequestAdditionalWorkForm({
  projectToken,
  catalog,
}: {
  projectToken: string;
  catalog: PublicCatalogItem[];
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(emptySelectedWork);
  const [state, formAction, pending] = useActionState(
    requestAdditionalWork,
    initialState,
  );
  const wasPending = useRef(false);
  const groups = useMemo(
    () => groupServiceCatalogItemsByCategory(catalog),
    [catalog],
  );

  useEffect(() => {
    if (wasPending.current && !pending && !state.error) {
      setOpen(false);
      setSelected(emptySelectedWork());
    }
    wasPending.current = pending;
  }, [pending, state]);

  if (!open) {
    return (
      <div className="space-y-2">
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          + Request Additional Work
        </Button>
        {state.message ? (
          <p className="text-sm text-muted-foreground">{state.message}</p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3 rounded-lg border p-3">
      <input type="hidden" name="projectToken" value={projectToken} />
      {selected.catalogIds.map((id) => (
        <input key={id} type="hidden" name="serviceCatalogItemId" value={id} />
      ))}
      {selected.catalogIds.map((id) => (
        <input
          key={`qty-${id}`}
          type="hidden"
          name={`quantity:${id}`}
          value={String(quantityForId(selected.quantities, id))}
        />
      ))}
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      {groups.length > 0 ? (
        <div className="space-y-3">
          <p className="text-sm font-medium">Select a service</p>
          {groups.map((group) => (
            <div key={group.category} className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {group.category}
              </p>
              <ul className="space-y-2">
                {group.items.map((item) => {
                  const checked = selected.catalogIds.includes(item.id);
                  const qty = quantityForId(selected.quantities, item.id);
                  return (
                    <li key={item.id} className="space-y-1 rounded-md border p-2">
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={checked}
                          onChange={() =>
                            setSelected((current) =>
                              toggleSelectedCatalog(current, item.id),
                            )
                          }
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{item.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {item.priceLabel}
                          </span>
                        </span>
                      </label>
                      {checked ? (
                        <div className="pl-6">
                          <Label
                            htmlFor={`additional-work-qty-${item.id}`}
                            className="text-xs"
                          >
                            Quantity
                          </Label>
                          <input
                            id={`additional-work-qty-${item.id}`}
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={99}
                            step={1}
                            value={qty}
                            className="mt-1 w-20 rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                            onChange={(event) => {
                              const parsed = parseRequestQuantity(
                                event.target.value,
                              );
                              if (parsed == null && event.target.value !== "") {
                                return;
                              }
                              setSelected((current) =>
                                setSelectedQuantity(
                                  current,
                                  item.id,
                                  parsed ?? 1,
                                ),
                              );
                            }}
                          />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          name="includeOther"
          value="on"
          checked={selected.includeOther}
          onChange={(event) =>
            setSelected((current) => ({
              ...current,
              includeOther: event.target.checked,
            }))
          }
        />
        <span>
          <span className="font-medium">{OTHER_TASK_LABEL}</span>
          <span className="block text-xs text-muted-foreground">
            Describe work that is not on the list. We will price it after review.
          </span>
        </span>
      </label>
      {selected.includeOther ? (
        <div className="space-y-2">
          <Label htmlFor="additional-work-other">Describe the other work</Label>
          <textarea
            id="additional-work-other"
            name="otherDescription"
            rows={3}
            className="w-full rounded-lg border border-input bg-transparent p-2.5 text-sm"
            placeholder="Describe the additional work you'd like us to look at."
            value={selected.otherDescription}
            onChange={(event) =>
              setSelected((current) => ({
                ...current,
                otherDescription: event.target.value,
              }))
            }
          />
        </div>
      ) : null}

      {groups.length === 0 && !selected.includeOther ? (
        <div className="space-y-2">
          <Label htmlFor="additional-work-description">
            What additional work would you like?
          </Label>
          <textarea
            id="additional-work-description"
            name="description"
            required
            rows={4}
            className="w-full rounded-lg border border-input bg-transparent p-2.5 text-sm"
            placeholder="Describe the additional work you'd like us to look at."
          />
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="additional-work-notes">Note (optional)</Label>
          <textarea
            id="additional-work-notes"
            name="notes"
            rows={3}
            className="w-full rounded-lg border border-input bg-transparent p-2.5 text-sm"
            placeholder="Anything else we should know?"
          />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        This sends a request only -- it does not change your approved
        project or price. We&apos;ll follow up with pricing if it turns
        into additional work.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Sending…" : "Send request"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

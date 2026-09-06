"use client";

import { Label } from "@/components/ui/label";
import type { PublicCatalogItem } from "@/lib/public-site";
import {
  WORK_AREA_INTAKE_CLEANUP_OPTIONS,
  WORK_AREA_INTAKE_CLARIFICATION,
  WORK_AREA_INTAKE_HANDLING_OPTIONS,
  WORK_AREA_INTAKE_PROTECTION_OPTIONS,
} from "@/lib/work-area-intake";

export type WorkAreaDraft = {
  contentsHandling: string;
  contentsProtection: string;
  belongingsCleanup: string;
};

export function RequestWorkAreaFields({
  items,
  selectedCatalogIds,
  values,
  onChange,
}: {
  items: PublicCatalogItem[];
  selectedCatalogIds: string[];
  values: Record<string, WorkAreaDraft>;
  onChange: (catalogItemId: string, next: WorkAreaDraft) => void;
}) {
  const rows = selectedCatalogIds
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is PublicCatalogItem => Boolean(item))
    .filter((item) => item.asksWorkAreaIntake);

  if (rows.length === 0) return null;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-extrabold tracking-wide uppercase">
          Work area & belongings
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Tell us whether the work area will be clear, whether remaining
          belongings need covering, and whether you want additional cleaning
          of belongings after construction. Ordinary construction cleanup and
          debris removal is included where applicable; detailed cleaning of
          customer belongings is separate.
        </p>
      </div>
      {rows.map((item) => {
        const draft = values[item.id] ?? {
          contentsHandling: "",
          contentsProtection: "",
          belongingsCleanup: "",
        };
        return (
          <fieldset key={item.id} className="space-y-4 rounded-md border border-border bg-white p-4">
            <legend className="px-1 text-sm font-extrabold">{item.name}</legend>
            <OptionGroup
              legend="Will the work area be reasonably clear and accessible before work begins?"
              name={`${item.id}-handling`}
              options={WORK_AREA_INTAKE_HANDLING_OPTIONS}
              value={draft.contentsHandling}
              onChange={(contentsHandling) => onChange(item.id, { ...draft, contentsHandling })}
            />
            <OptionGroup
              legend="Do belongings remaining in or near the work area need contractor-provided covering or protection?"
              name={`${item.id}-protection`}
              options={WORK_AREA_INTAKE_PROTECTION_OPTIONS}
              value={draft.contentsProtection}
              onChange={(contentsProtection) =>
                onChange(item.id, { ...draft, contentsProtection })
              }
            />
            <OptionGroup
              legend="Do you want additional cleaning of belongings remaining in the work area after construction?"
              name={`${item.id}-cleanup`}
              options={WORK_AREA_INTAKE_CLEANUP_OPTIONS}
              value={draft.belongingsCleanup}
              onChange={(belongingsCleanup) =>
                onChange(item.id, { ...draft, belongingsCleanup })
              }
            />
          </fieldset>
        );
      })}
      <p className="text-sm text-muted-foreground">{WORK_AREA_INTAKE_CLARIFICATION}</p>
    </div>
  );
}

function OptionGroup({
  legend,
  name,
  options,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="space-y-2">
        {options.map((option) => (
          <Label key={option.value} className="flex items-start gap-2 font-normal">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="mt-1"
            />
            <span>{option.label}</span>
          </Label>
        ))}
      </div>
    </fieldset>
  );
}

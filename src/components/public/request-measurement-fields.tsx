"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  catalogAsksMeasurements,
  measurementUnitLabel,
  resolveCatalogIntakeConfig,
  type IntakeMeasurementAxis,
} from "@/lib/catalog-intake";
import type { PublicCatalogItem } from "@/lib/public-site";

export type MeasurementDraft = {
  width: string;
  height: string;
  length: string;
};

const AXIS_LABELS: Record<IntakeMeasurementAxis, string> = {
  width: "Approximate width",
  height: "Approximate height",
  length: "Approximate depth / length",
};

export function RequestMeasurementFields({
  items,
  selectedCatalogIds,
  values,
  onChange,
}: {
  items: PublicCatalogItem[];
  selectedCatalogIds: string[];
  values: Record<string, MeasurementDraft>;
  onChange: (catalogItemId: string, next: MeasurementDraft) => void;
}) {
  const rows = selectedCatalogIds
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is PublicCatalogItem => Boolean(item))
    .filter((item) => catalogAsksMeasurements(resolveCatalogIntakeConfig(item)));

  if (rows.length === 0) return null;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-extrabold tracking-wide uppercase">
          Approximate measurements (if known)
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          These help us understand the project and provide a preliminary
          estimate. Final measurements may be verified before work or material
          ordering.
        </p>
      </div>
      {rows.map((item) => {
        const config = resolveCatalogIntakeConfig(item);
        const draft = values[item.id] ?? { width: "", height: "", length: "" };
        const unit = measurementUnitLabel(config.unit);
        return (
          <fieldset key={item.id} className="space-y-3 rounded-md border border-border bg-white p-4">
            <legend className="px-1 text-sm font-extrabold">{item.name}</legend>
            {config.mode === "RECOMMENDED" ? (
              <p className="text-sm text-muted-foreground">Recommended if you have them.</p>
            ) : null}
            {config.mode === "REQUIRED" ? (
              <p className="text-sm text-muted-foreground">Needed for a preliminary quote.</p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              {config.axes.map((axis) => (
                <div key={axis} className="space-y-2">
                  <Label htmlFor={`${item.id}-${axis}`}>
                    {AXIS_LABELS[axis]} ({unit})
                  </Label>
                  <Input
                    id={`${item.id}-${axis}`}
                    inputMode="decimal"
                    value={draft[axis]}
                    onChange={(event) =>
                      onChange(item.id, { ...draft, [axis]: event.target.value })
                    }
                    className="h-12 bg-white text-base"
                  />
                </div>
              ))}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

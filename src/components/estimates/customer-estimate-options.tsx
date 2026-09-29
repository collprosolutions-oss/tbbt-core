import { CustomerEstimateLineSections } from "@/components/estimates/customer-estimate-line-sections";
import { ESTIMATE_TOTAL_CUSTOMER_LABEL } from "@/lib/estimate-document";
import type { EstimateDocumentOption } from "@/lib/estimate-document";

export function CustomerEstimateOptions({
  options,
  selectable,
  selectedOptionId,
}: {
  options: EstimateDocumentOption[];
  selectable: boolean;
  selectedOptionId?: string;
}) {
  if (options.length === 0) return null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {selectedOptionId || options.some((option) => option.approved)
          ? "Approved scope"
          : "Priced options: choose one below"}
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {options.map((option) => {
          const selected = selectedOptionId === option.id || option.approved;
          return (
            <label
              key={option.id}
              className={`block rounded-xl border p-4 ${
                selected ? "border-foreground" : "border-border"
              }`}
            >
              {selectable ? (
                <input
                  type="radio"
                  name="estimateOptionId"
                  value={option.id}
                  required
                  defaultChecked={selected}
                  className="mb-3"
                />
              ) : null}
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h3 className="font-semibold">{option.name}</h3>
                <p className="text-lg font-semibold tabular-nums">{option.totalLabel}</p>
              </div>
              <CustomerEstimateLineSections
                laborLines={option.laborLines}
                materialLines={option.materialLines}
                otherLines={option.otherLines}
              />
              <div className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Labor</span>
                  <span className="tabular-nums">{option.laborTotalLabel}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Materials</span>
                  <span className="tabular-nums">{option.materialTotalLabel}</span>
                </div>
                {option.otherTotalLabel ? (
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">Other</span>
                    <span className="tabular-nums">{option.otherTotalLabel}</span>
                  </div>
                ) : null}
                {option.laborMinimumLabel && option.laborMinimumAmountLabel ? (
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">{option.laborMinimumLabel}</span>
                    <span className="tabular-nums">{option.laborMinimumAmountLabel}</span>
                  </div>
                ) : null}
                <div className="flex justify-between gap-4 border-t border-border pt-2 font-medium">
                  <span>{ESTIMATE_TOTAL_CUSTOMER_LABEL}</span>
                  <span className="tabular-nums">{option.totalLabel}</span>
                </div>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

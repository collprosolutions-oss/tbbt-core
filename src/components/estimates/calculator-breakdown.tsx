import { formatMoney } from "@/lib/format";
import type { CalculatorResult, CalculatorSnapshot } from "@/lib/estimate-calculators";

export function CalculatorBreakdown({
  snapshot,
  result,
  title = "Internal labor calculator",
}: {
  snapshot?: CalculatorSnapshot | null;
  result?: CalculatorResult | null;
  title?: string;
}) {
  const breakdown = result ?? snapshot?.result;
  if (!breakdown) return null;

  return (
    <div className="mt-2 rounded-lg border border-border/60 bg-muted/30 p-3">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">
        Owner/internal only — not shown to the customer.
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        {breakdown.lines.map((line) => (
          <li key={line.key} className="flex justify-between gap-3">
            <span>{line.label}</span>
            <span className="shrink-0 tabular-nums">{formatMoney(line.amount)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 font-medium">
        Recommended labor price: {formatMoney(breakdown.recommendedAmount)}
      </p>
      {snapshot?.overriddenAmount != null ? (
        <p className="text-sm text-muted-foreground">
          Owner override: {formatMoney(snapshot.overriddenAmount)}
        </p>
      ) : null}
    </div>
  );
}

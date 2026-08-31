import { formatMoney } from "@/lib/format";
import type { TimePoint } from "@/lib/reports";

export function ReportChart({ points, emptyLabel }: { points: TimePoint[]; emptyLabel: string }) {
  if (points.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  const max = Math.max(...points.map((point) => point.amount), 0);
  const height = 160;

  return (
    <div className="space-y-3">
      <div className="flex h-40 items-end gap-1.5 sm:gap-2">
        {points.map((point) => {
          const ratio = max > 0 ? point.amount / max : 0;
          const barHeight = Math.max(ratio * height, point.amount > 0 ? 4 : 0);
          return (
            <div key={point.key} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
              <div
                className="w-full max-w-10 rounded-t-sm bg-primary/70"
                style={{ height: `${barHeight}px` }}
                title={`${point.label}: ${formatMoney(point.amount)}`}
              />
            </div>
          );
        })}
      </div>
      <div className="flex gap-1.5 sm:gap-2">
        {points.map((point) => (
          <p
            key={`${point.key}-label`}
            className="min-w-0 flex-1 truncate text-center text-[10px] text-muted-foreground"
          >
            {point.label}
          </p>
        ))}
      </div>
    </div>
  );
}

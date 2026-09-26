import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { OwnerTodayFieldProblemItem } from "@/lib/owner-today";

export function OwnerTodayFieldProblemAttention({
  items,
}: {
  items: OwnerTodayFieldProblemItem[];
}) {
  if (items.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Field reports needing attention</p>
      {items.map((item) => (
        <div
          key={item.reportId}
          className="flex flex-wrap items-start justify-between gap-2 rounded-xl border p-3"
        >
          <div className="min-w-0 space-y-1">
            <p className="font-medium">{item.customerName}</p>
            <p className="text-sm text-muted-foreground">
              Reported by {item.reporterName}
            </p>
            <p className="whitespace-pre-wrap text-sm">{item.description}</p>
            <p className="text-sm text-muted-foreground">{item.reportedAtLabel}</p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={item.href}>Open Work Order</Link>
          </Button>
        </div>
      ))}
    </div>
  );
}

import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { businessTimelineEventLabel } from "@/lib/business-timeline";
import type { BusinessTimelineItem } from "@/lib/business-timeline";
import { formatDateTime } from "@/lib/format";

export function TimelineList({
  items,
  timeZone,
  truncated,
  lookbackDays,
  limit,
}: {
  items: BusinessTimelineItem[];
  timeZone: string;
  truncated: boolean;
  lookbackDays: number;
  limit: number;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="No recorded business events"
        description="Nothing persisted in this window matches the current filters."
      />
    );
  }

  return (
    <div className="space-y-3">
      {truncated ? (
        <p className="text-xs text-muted-foreground">
          Showing the {limit} most recent recorded events from the last {lookbackDays}{" "}
          days. Older history is not loaded.
        </p>
      ) : null}
      <ol className="space-y-3">
        {items.map((item) => (
          <li key={item.id} className="rounded-md border border-border/70 p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-foreground">
                {formatDateTime(new Date(item.occurredAt), timeZone)}
              </span>
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                {item.category}
              </span>
              <span className="text-muted-foreground">
                {businessTimelineEventLabel(item.eventType)}
              </span>
              {item.sourceStatus ? <StatusBadge status={item.sourceStatus} /> : null}
            </div>
            <p className="mt-1 text-sm text-foreground">{item.description}</p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {item.customerName ? (
                item.customerId ? (
                  <Link
                    href={`/customers/${item.customerId}`}
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    {item.customerName}
                  </Link>
                ) : (
                  <span>{item.customerName}</span>
                )
              ) : null}
              {item.relatedHref ? (
                <Link
                  href={item.relatedHref}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  Open {item.relatedLabel}
                </Link>
              ) : (
                <span>{item.relatedLabel}</span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

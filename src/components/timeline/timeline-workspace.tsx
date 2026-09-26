import Link from "next/link";
import { TimelineList } from "@/components/timeline/timeline-list";
import { Button } from "@/components/ui/button";
import {
  BUSINESS_TIMELINE_CATEGORIES,
  BUSINESS_TIMELINE_CATEGORY_LABELS,
  type BusinessTimeline,
} from "@/lib/business-timeline";
import { cn } from "@/lib/utils";

function timelineHref(input: { category?: string; customerId?: string | null }) {
  const params = new URLSearchParams();
  if (input.category && input.category !== "all") params.set("category", input.category);
  if (input.customerId) params.set("customerId", input.customerId);
  const query = params.toString();
  return query ? `/timeline?${query}` : "/timeline";
}

export function TimelineWorkspace({ source }: { source: BusinessTimeline }) {
  return (
    <div className="space-y-5">
      <form method="get" action="/timeline" className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Customer</span>
          <select
            name="customerId"
            defaultValue={source.customerId ?? ""}
            className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm"
          >
            <option value="">All customers</option>
            {source.customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </label>
        {source.category !== "all" ? (
          <input type="hidden" name="category" value={source.category} />
        ) : null}
        <Button type="submit" variant="outline" size="sm">
          Apply
        </Button>
      </form>

      <nav className="flex flex-wrap gap-2" aria-label="Timeline category">
        {BUSINESS_TIMELINE_CATEGORIES.map((category) => {
          const active = source.category === category;
          return (
            <Link
              key={category}
              href={timelineHref({ category, customerId: source.customerId })}
              className={cn(
                "rounded-full border px-3 py-1 text-sm",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {BUSINESS_TIMELINE_CATEGORY_LABELS[category]}
            </Link>
          );
        })}
      </nav>

      <p className="text-xs text-muted-foreground">
        Times are shown in {source.timeZone}. Stored timestamps are not rewritten.
      </p>

      <TimelineList
        items={source.items}
        timeZone={source.timeZone}
        truncated={source.truncated}
        lookbackDays={source.lookbackDays}
        limit={source.limit}
      />
    </div>
  );
}

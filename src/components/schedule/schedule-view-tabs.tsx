import Link from "next/link";
import { SCHEDULE_VIEWS, formatISODate, type ScheduleView } from "@/lib/schedule";
import { cn } from "@/lib/utils";

const VIEW_LABELS: Record<ScheduleView, string> = {
  month: "Month",
  week: "Week",
  day: "Day",
  crew: "Crew",
  list: "List",
};

/**
 * Plain server-rendered navigation links (no client JS needed): switching
 * views is just a URL change, so this stays a Server Component like the
 * rest of this page.
 */
export function ScheduleViewTabs({
  view,
  date,
}: {
  view: ScheduleView;
  date: Date;
}) {
  const iso = formatISODate(date);
  return (
    <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/30 p-1">
      {SCHEDULE_VIEWS.map((candidate) => (
        <Link
          key={candidate}
          href={`/jobs?view=${candidate}&date=${iso}`}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            candidate === view
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {VIEW_LABELS[candidate]}
        </Link>
      ))}
    </div>
  );
}

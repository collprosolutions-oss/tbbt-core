import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  addDays,
  addMonths,
  formatISODate,
  startOfDay,
  type ScheduleView,
} from "@/lib/schedule";

/**
 * Prev / Today / Next navigation for date-driven views. List has no date
 * concept (it shows every current Job grouped by status, not by date), so
 * it renders nothing here -- callers should not render this for view="list".
 */
export function ScheduleDateNav({
  view,
  date,
  label,
}: {
  view: ScheduleView;
  date: Date;
  label: string;
}) {
  const step = view === "week" ? 7 : 1;
  const prevDate =
    view === "month" || view === "crew"
      ? addMonths(date, -1)
      : addDays(date, -step);
  const nextDate =
    view === "month" || view === "crew"
      ? addMonths(date, 1)
      : addDays(date, step);
  const todayIso = formatISODate(startOfDay(new Date()));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild size="sm" variant="outline">
        <Link href={`/jobs?view=${view}&date=${formatISODate(prevDate)}`}>
          ← Prev
        </Link>
      </Button>
      <Button asChild size="sm" variant="outline">
        <Link href={`/jobs?view=${view}&date=${todayIso}`}>Today</Link>
      </Button>
      <Button asChild size="sm" variant="outline">
        <Link href={`/jobs?view=${view}&date=${formatISODate(nextDate)}`}>
          Next →
        </Link>
      </Button>
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}

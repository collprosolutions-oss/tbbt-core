import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  addDays,
  addMonths,
  formatISODate,
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
  todayIso,
  timeZone,
}: {
  view: ScheduleView;
  date: Date;
  label: string;
  todayIso: string;
  timeZone?: string;
}) {
  const step = view === "week" ? 7 : 1;
  const prevDate =
    view === "month" || view === "crew"
      ? addMonths(date, -1, timeZone)
      : addDays(date, -step, timeZone);
  const nextDate =
    view === "month" || view === "crew"
      ? addMonths(date, 1, timeZone)
      : addDays(date, step, timeZone);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild size="sm" variant="outline">
        <Link href={`/jobs?view=${view}&date=${formatISODate(prevDate, timeZone)}`}>
          ← Prev
        </Link>
      </Button>
      <Button asChild size="sm" variant="outline">
        <Link href={`/jobs?view=${view}&date=${todayIso}`}>Today</Link>
      </Button>
      <Button asChild size="sm" variant="outline">
        <Link href={`/jobs?view=${view}&date=${formatISODate(nextDate, timeZone)}`}>
          Next →
        </Link>
      </Button>
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}

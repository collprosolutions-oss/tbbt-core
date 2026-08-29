import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { JobPill } from "@/components/schedule/job-pill";
import {
  dayTone,
  dayToneClasses,
  formatISODate,
  type ScheduleJob,
} from "@/lib/schedule";
import { cn } from "@/lib/utils";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_VISIBLE_PER_DAY = 3;

/**
 * The primary planning view: a conventional calendar grid. Each day cell
 * links to Day view (a mobile-friendly "compact calendar + selected-day
 * list" pattern -- see the MOBILE section of the spec) and every individual
 * Job pill links straight to its Job / Work Order.
 */
export function MonthView({
  days,
  monthStart,
  monthEnd,
  today,
  jobsByDay,
  conflicts,
}: {
  days: Date[];
  monthStart: Date;
  monthEnd: Date;
  today: Date;
  jobsByDay: Map<string, ScheduleJob[]>;
  conflicts: Map<string, ScheduleJob[]>;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="grid grid-cols-7 border-b text-center text-[11px] font-medium text-muted-foreground sm:text-xs">
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} className="border-r px-1 py-2 last:border-r-0">
              {label}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((day) => {
            const iso = formatISODate(day);
            const inMonth = day >= monthStart && day < monthEnd;
            const tone = dayTone(day, today);
            const dayJobs = jobsByDay.get(iso) ?? [];
            const visibleJobs = dayJobs.slice(0, MAX_VISIBLE_PER_DAY);
            const hiddenCount = dayJobs.length - visibleJobs.length;
            return (
              <div
                key={iso}
                className={cn(
                  "min-h-[76px] border-b border-r p-1 last:border-r-0 sm:min-h-[112px] sm:p-1.5",
                  dayToneClasses(tone),
                  !inMonth && "opacity-45",
                )}
              >
                <Link
                  href={`/jobs?view=day&date=${iso}`}
                  className={cn(
                    "inline-flex size-5 items-center justify-center rounded-full text-[11px] font-semibold sm:size-6 sm:text-xs",
                    tone === "today" && "bg-green-600 text-white",
                  )}
                >
                  {day.getDate()}
                </Link>
                <div className="mt-1 space-y-0.5">
                  {visibleJobs.map((job) => (
                    <JobPill
                      key={job.id}
                      job={job}
                      hasConflict={conflicts.has(job.id)}
                    />
                  ))}
                  {hiddenCount > 0 ? (
                    <Link
                      href={`/jobs?view=day&date=${iso}`}
                      className="block text-[10px] font-medium text-muted-foreground underline underline-offset-2 sm:text-[11px]"
                    >
                      +{hiddenCount} more
                    </Link>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

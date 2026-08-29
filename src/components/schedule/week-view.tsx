import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { JobScheduleRow } from "@/components/schedule/job-schedule-row";
import { formatDate } from "@/lib/format";
import {
  dayTone,
  dayToneClasses,
  formatISODate,
  type ScheduleJob,
} from "@/lib/schedule";
import { cn } from "@/lib/utils";

/**
 * Operational week view: each day's scheduled Jobs in start-time order, so
 * OWNER/ADMIN can read workload and conflicts without opening every Job.
 * Stacks to a single column on mobile via the sm:grid-cols-7 breakpoint.
 */
export function WeekView({
  days,
  today,
  jobsByDay,
  conflicts,
}: {
  days: Date[];
  today: Date;
  jobsByDay: Map<string, ScheduleJob[]>;
  conflicts: Map<string, ScheduleJob[]>;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-7">
      {days.map((day) => {
        const iso = formatISODate(day);
        const tone = dayTone(day, today);
        const dayJobs = jobsByDay.get(iso) ?? [];
        return (
          <Card key={iso} className={cn("sm:col-span-1", dayToneClasses(tone))}>
            <CardHeader className="pb-2">
              <CardDescription>
                {day.toLocaleDateString("en-US", { weekday: "short" })}
              </CardDescription>
              <CardTitle className="text-base">
                <Link
                  href={`/jobs?view=day&date=${iso}`}
                  className="underline-offset-4 hover:underline"
                >
                  {formatDate(day)}
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {dayJobs.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No jobs scheduled.
                </p>
              ) : (
                dayJobs.map((job) => (
                  <JobScheduleRow
                    key={job.id}
                    job={job}
                    hasConflict={conflicts.has(job.id)}
                  />
                ))
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

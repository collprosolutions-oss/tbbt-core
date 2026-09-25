import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DailyCapacity, WeeklyCapacity } from "@/lib/workforce-capacity";
import type { ScheduleConflict } from "@/lib/workforce-conflicts";
import type { BsosRecommendation } from "@/lib/bsos";

function severityBadge(severity: ScheduleConflict["severity"]) {
  if (severity === "ERROR") return <Badge variant="destructive">Error</Badge>;
  if (severity === "WARNING") return <Badge variant="secondary">Warning</Badge>;
  return <Badge variant="outline">Info</Badge>;
}

export function CapacityIntelligencePanel({
  week,
  today,
  conflicts,
  recommendations,
}: {
  week: WeeklyCapacity;
  today: DailyCapacity | null;
  conflicts: ScheduleConflict[];
  recommendations: BsosRecommendation[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Capacity &amp; workforce</CardTitle>
        <CardDescription>
          Known scheduled time, configured buffers, and estimated travel placeholders
          are counted separately. Travel is not GPS routing. Recommendations never
          assign workers or move jobs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {today ? (
          <p>
            Today: {today.knownScheduledMinutes} min known, {today.configuredBufferMinutes} min
            buffer, {today.pickupMinutes} min pickup, {today.travelPlaceholderMinutes} min travel
            placeholder, {today.remainingMinutes} min remaining
            {today.overloaded ? " — overloaded" : ""}
            {today.helperRecommended ? " — helper recommended" : ""}.
          </p>
        ) : null}
        <p>
          Next 7 days: {week.knownScheduledMinutes} min known / {week.availableMinutes} min
          available, {week.overloadedDays} overloaded day{week.overloadedDays === 1 ? "" : "s"}
          {week.forecastRecurringMinutes > 0
            ? `, ${week.forecastRecurringMinutes} min forecast recurring`
            : ""}
          .
        </p>
        {conflicts.length > 0 ? (
          <ul className="space-y-1">
            {conflicts.slice(0, 6).map((conflict, index) => (
              <li key={`${conflict.kind}-${conflict.jobId}-${index}`} className="flex gap-2">
                {severityBadge(conflict.severity)}
                <span>{conflict.explanation}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">No worker double-booking or cascade risk on this range.</p>
        )}
        {recommendations.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5">
            {recommendations.slice(0, 4).map((row) => (
              <li key={row.key}>{row.title}: {row.why}</li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

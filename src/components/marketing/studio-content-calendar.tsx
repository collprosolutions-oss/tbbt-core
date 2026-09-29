import { StudioPublicationDayForm } from "@/components/marketing/studio-publication-day-form";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CALENDAR_INTERNAL_MESSAGE,
  MARKETING_CHANNEL_LABELS,
  MARKETING_CONTENT_TYPE_LABELS,
  STUDIO_CALENDAR_PAST_LABEL,
  STUDIO_CONTENT_CALENDAR_LIMITS_MESSAGE,
  STUDIO_CONTENT_CALENDAR_MESSAGE,
  canPlanStudioPublicationDay,
  type MarketingChannel,
  type MarketingContentType,
} from "@/lib/marketing";
import type { MarketingSource } from "@/lib/marketing-data";

export function StudioContentCalendar({
  calendar,
  weeklyPlanCount,
  viewerRole,
  compact = false,
}: {
  calendar: MarketingSource["contentCalendar"];
  weeklyPlanCount: number;
  viewerRole: string;
  compact?: boolean;
}) {
  const canPlan = canPlanStudioPublicationDay(viewerRole);
  const upcomingDays = compact ? calendar.days.slice(0, 4) : calendar.days;
  const groups = [
    ...upcomingDays,
    ...(!compact && calendar.unscheduled ? [calendar.unscheduled] : []),
  ];
  const visibleItems = groups.flatMap((day) => day.items);
  const pastDays = compact ? [] : calendar.pastDays;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Content calendar</CardTitle>
        <CardDescription>
          {STUDIO_CONTENT_CALENDAR_MESSAGE} {CALENDAR_INTERNAL_MESSAGE} {STUDIO_CONTENT_CALENDAR_LIMITS_MESSAGE} This
          week has {weeklyPlanCount} planned item{weeklyPlanCount === 1 ? "" : "s"} in {calendar.timeZone}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {visibleItems.length === 0 && pastDays.length === 0 ? (
          <EmptyState
            title="No recorded packages on the calendar"
            description="Creator packages appear here after they are saved. Planning a day does not approve or publish them."
          />
        ) : (
          <>
            {groups.map((group) => (
              <CalendarDayGroup
                key={group.day ?? "unscheduled"}
                group={group}
                timeZone={calendar.timeZone}
                canPlan={canPlan}
                compact={compact}
              />
            ))}
            {pastDays.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{STUDIO_CALENDAR_PAST_LABEL}</h3>
                {pastDays.map((group) => (
                  <CalendarDayGroup
                    key={group.day ?? "past"}
                    group={group}
                    timeZone={calendar.timeZone}
                    canPlan={canPlan}
                    compact={compact}
                  />
                ))}
              </section>
            ) : null}
          </>
        )}
        {calendar.truncated ? (
          <p className="text-xs text-muted-foreground">
            Showing up to {calendar.limit} unplanned, {calendar.limit} from today, and {calendar.limit} past
            packages ({calendar.total} recorded).
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {calendar.total} recorded package{calendar.total === 1 ? "" : "s"}. Limit {calendar.limit} per group.
          </p>
        )}
        <p className="text-xs text-muted-foreground">{calendar.limits.message}</p>
      </CardContent>
    </Card>
  );
}

function CalendarDayGroup({
  group,
  timeZone,
  canPlan,
  compact,
}: {
  group: MarketingSource["contentCalendar"]["days"][number];
  timeZone: string;
  canPlan: boolean;
  compact: boolean;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{group.label}</h3>
      {group.items.map((row) => (
        <div key={row.id} className="space-y-2 rounded-lg border border-border/70 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-medium">{row.title}</p>
              <p className="text-xs text-muted-foreground">
                {MARKETING_CONTENT_TYPE_LABELS[row.contentType as MarketingContentType] ?? row.contentType}
                {" · "}
                {MARKETING_CHANNEL_LABELS[row.channelIntent as MarketingChannel] ?? row.channelIntent}
              </p>
            </div>
            <StatusBadge status={row.status} />
          </div>
          <p className="text-xs text-muted-foreground">
            Approval: {row.approvalLabel} · Export: {row.exportLabel}
            {row.plannedDay ? ` · Planned ${row.plannedDay}` : ""}
          </p>
          {!compact ? (
            <StudioPublicationDayForm
              contentId={row.id}
              plannedDay={row.plannedDay ?? ""}
              expectedUpdatedAt={row.updatedAt.toISOString()}
              timeZone={timeZone}
              canPlan={canPlan}
            />
          ) : null}
        </div>
      ))}
    </section>
  );
}

import Link from "next/link";
import { CopyDirectionsLinkButton } from "@/components/today/copy-directions-link-button";
import { OwnerDayRouteAppointmentForm } from "@/components/today/owner-day-route-appointment-form";
import { OwnerDayRouteAppointmentNoticeForm } from "@/components/today/owner-day-route-appointment-notice";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatISODateInTimeZone, formatZonedTimeInput } from "@/lib/business-timezone";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  OWNER_DAY_ROUTE_EXCLUDED_HEADING,
  OWNER_DAY_ROUTE_MAPS_LINK_LABEL,
  OWNER_DAY_ROUTE_NO_MAPPABLE_MESSAGE,
  OWNER_DAY_ROUTE_NO_STOPS_MESSAGE,
  OWNER_DAY_ROUTE_PATH,
  ownerDayRouteExclusionLine,
  ownerDayRouteMapsTruncationNote,
  type OwnerDayRouteView,
} from "@/lib/owner-day-route";
import type { OwnerDayRouteAppointmentNoticePreview } from "@/lib/owner-day-route-appointment-notice";

function dayHref(dateIso: string) {
  return `${OWNER_DAY_ROUTE_PATH}?date=${dateIso}`;
}

export function OwnerDayRouteView({
  view,
  previousDateIso,
  nextDateIso,
  canChangeAppointment = false,
  appointmentNotices = {},
}: {
  view: OwnerDayRouteView;
  previousDateIso: string;
  nextDateIso: string;
  canChangeAppointment?: boolean;
  appointmentNotices?: Record<string, OwnerDayRouteAppointmentNoticePreview>;
}) {
  const truncationNote = ownerDayRouteMapsTruncationNote(view.maps);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link href={dayHref(previousDateIso)}>Previous day</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={OWNER_DAY_ROUTE_PATH}>Today</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={dayHref(nextDateIso)}>Next day</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href="/today">Today board</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`/jobs?view=day&date=${view.dateIso}`}>Day schedule</Link>
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">{view.readOnlyMessage}</p>
      <p className="text-sm text-muted-foreground">{view.orderNote}</p>
      <p className="text-sm text-muted-foreground">{view.mapsDisclaimer}</p>

      <Card>
        <CardHeader>
          <CardTitle>Maps link</CardTitle>
          <CardDescription>
            {view.maps.href
              ? `${view.maps.includedStopCount} eligible stop${view.maps.includedStopCount === 1 ? "" : "s"} in recorded appointment order.`
              : OWNER_DAY_ROUTE_NO_MAPPABLE_MESSAGE}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {view.maps.href ? (
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <a href={view.maps.href} target="_blank" rel="noreferrer noopener">
                  {OWNER_DAY_ROUTE_MAPS_LINK_LABEL}
                </a>
              </Button>
              <CopyDirectionsLinkButton href={view.maps.href} label="Copy maps link" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{OWNER_DAY_ROUTE_NO_MAPPABLE_MESSAGE}</p>
          )}
          {truncationNote ? (
            <p className="text-sm text-muted-foreground">{truncationNote}</p>
          ) : null}
          {view.excludedStops.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">{OWNER_DAY_ROUTE_EXCLUDED_HEADING}</p>
              <ul className="space-y-1">
                {view.excludedStops.map((stop) => (
                  <li
                    key={stop.jobId}
                    className="text-sm text-amber-800 dark:text-amber-300"
                  >
                    {ownerDayRouteExclusionLine(stop)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {view.stops.length === 0 ? (
        <EmptyState title="No stops" description={OWNER_DAY_ROUTE_NO_STOPS_MESSAGE} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Ordered stops</CardTitle>
            <CardDescription>
              {view.includedStops.length} complete for maps, {view.excludedStops.length} excluded.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {view.stops.map((stop) => (
              <article
                key={stop.jobId}
                className="rounded-xl border border-border/80 bg-card p-3.5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium text-muted-foreground">Stop {stop.sequence}</p>
                    <p className="truncate text-base font-semibold">{stop.customerName}</p>
                    {stop.appointmentWindowLabel ? (
                      <p className="text-sm tabular-nums text-muted-foreground">
                        {stop.appointmentWindowLabel}
                      </p>
                    ) : null}
                    {stop.address ? (
                      <p className="text-sm text-muted-foreground">{stop.address}</p>
                    ) : null}
                  </div>
                  <StatusBadge status={stop.status} />
                </div>

                {stop.materialPickup.recorded ? (
                  <div className="mt-3 space-y-0.5 text-sm">
                    <p className="font-medium">
                      Recorded material pickup: {stop.materialPickup.durationMinutes} min before
                      appointment
                    </p>
                    {stop.materialPickup.blockLabel ? (
                      <p className="tabular-nums text-muted-foreground">
                        {stop.materialPickup.blockLabel}
                      </p>
                    ) : null}
                    {stop.materialPickup.scheduledNote ? (
                      <p className="text-muted-foreground">{stop.materialPickup.scheduledNote}</p>
                    ) : null}
                  </div>
                ) : null}

                {stop.exclusionLabel ? (
                  <p className="mt-3 text-sm text-amber-800 dark:text-amber-300">
                    {stop.exclusionLabel}
                  </p>
                ) : null}

                <div className="mt-3">
                  <Button asChild size="sm" variant="outline">
                    <Link href={stop.jobHref}>Open job</Link>
                  </Button>
                </div>
                {canChangeAppointment ? (
                  <OwnerDayRouteAppointmentForm
                    jobId={stop.jobId}
                    timeZone={view.timeZone}
                    date={formatISODateInTimeZone(stop.scheduledAt, view.timeZone)}
                    time={formatZonedTimeInput(stop.scheduledAt, view.timeZone)}
                    snapshot={stop.scheduleSnapshot}
                  />
                ) : null}
                {canChangeAppointment && appointmentNotices[stop.jobId] ? (
                  <OwnerDayRouteAppointmentNoticeForm
                    notice={appointmentNotices[stop.jobId]}
                    timeZone={view.timeZone}
                  />
                ) : null}
              </article>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

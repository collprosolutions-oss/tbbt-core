import { formatAddress } from "@/lib/format";
import {
  OWNER_DAY_ROUTE_EXCLUDED_HEADING,
  OWNER_DAY_ROUTE_FOREIGN_PROPERTY_LABEL,
  OWNER_DAY_ROUTE_INCOMPLETE_LABEL,
  OWNER_DAY_ROUTE_JOBS_TAKE,
  OWNER_DAY_ROUTE_MAPS_DISCLAIMER,
  OWNER_DAY_ROUTE_MUTATIONS_ON_LOAD,
  OWNER_DAY_ROUTE_NO_PROPERTY_LABEL,
  OWNER_DAY_ROUTE_ORDER_NOTE,
  OWNER_DAY_ROUTE_READ_ONLY_MESSAGE,
} from "@/lib/owner-day-route/constants";
import { completeStructuredRouteAddress, sameBusinessJob } from "@/lib/owner-day-route/address";
import {
  buildOwnerDayRouteMapsHandoff,
  eligibleOwnerDayRouteMapsQueries,
} from "@/lib/owner-day-route/maps";
import type {
  OwnerDayRouteExclusionReason,
  OwnerDayRouteJobRecord,
  OwnerDayRouteStop,
  OwnerDayRouteView,
} from "@/lib/owner-day-route/types";
import {
  buildMaterialPickupVisibility,
  ownerTodayTimeWindowLabel,
} from "@/lib/owner-today";
import { dayLabel, formatISODate, type DateRange } from "@/lib/schedule";

function exclusionLabel(reason: OwnerDayRouteExclusionReason) {
  if (reason === "NO_PROPERTY") return OWNER_DAY_ROUTE_NO_PROPERTY_LABEL;
  if (reason === "FOREIGN_PROPERTY") return OWNER_DAY_ROUTE_FOREIGN_PROPERTY_LABEL;
  return OWNER_DAY_ROUTE_INCOMPLETE_LABEL;
}

function ownedDisplayAddress(
  job: OwnerDayRouteJobRecord,
  businessId: string,
): string | null {
  const property = job.property;
  if (!property || property.businessId !== businessId) return null;
  const formatted = formatAddress(property);
  return formatted.trim() ? formatted : null;
}

export function buildOwnerDayRouteStop(
  job: OwnerDayRouteJobRecord,
  options: { businessId: string; range: DateRange; timeZone: string; sequence: number },
): OwnerDayRouteStop | null {
  if (!sameBusinessJob(job, options.businessId)) return null;
  if (!job.scheduledAt) return null;
  if (job.scheduledAt < options.range.start || job.scheduledAt >= options.range.end) {
    return null;
  }

  const structured = completeStructuredRouteAddress(job.property, options.businessId);
  const includedInMaps = structured.ok;
  const exclusionReason = structured.ok ? null : structured.reason;

  return {
    jobId: job.id,
    businessId: job.businessId,
    sequence: options.sequence,
    customerName: job.customer?.name?.trim() || "Customer",
    status: job.status,
    scheduledAt: job.scheduledAt,
    appointmentWindowLabel: ownerTodayTimeWindowLabel(job, options.timeZone),
    materialPickup: buildMaterialPickupVisibility(job, options.timeZone),
    includedInMaps,
    exclusionReason,
    exclusionLabel: exclusionReason ? exclusionLabel(exclusionReason) : null,
    address: includedInMaps ? structured.address.formatted : ownedDisplayAddress(job, options.businessId),
    mapsQuery: includedInMaps ? structured.address.formatted : null,
    jobHref: `/jobs/${job.id}`,
  };
}

export function buildOwnerDayRouteView(
  jobs: readonly OwnerDayRouteJobRecord[],
  options: {
    businessId: string;
    range: DateRange;
    timeZone: string;
  },
): OwnerDayRouteView {
  const ordered = [...jobs]
    .filter((job) => sameBusinessJob(job, options.businessId))
    .filter((job) => job.scheduledAt)
    .sort((left, right) => {
      const leftTime = left.scheduledAt?.getTime() ?? 0;
      const rightTime = right.scheduledAt?.getTime() ?? 0;
      if (leftTime !== rightTime) return leftTime - rightTime;
      return left.id.localeCompare(right.id);
    });

  const stops: OwnerDayRouteStop[] = [];
  for (const job of ordered) {
    const stop = buildOwnerDayRouteStop(job, {
      ...options,
      sequence: stops.length + 1,
    });
    if (stop) stops.push(stop);
  }

  const includedStops = stops.filter((stop) => stop.includedInMaps);
  const excludedStops = stops.filter((stop) => !stop.includedInMaps);
  const maps = buildOwnerDayRouteMapsHandoff(eligibleOwnerDayRouteMapsQueries(stops));

  return {
    businessId: options.businessId,
    dateIso: formatISODate(options.range.start, options.timeZone),
    dayLabel: dayLabel(options.range.start, options.timeZone),
    timeZone: options.timeZone,
    readOnly: true,
    mutationsOnLoad: OWNER_DAY_ROUTE_MUTATIONS_ON_LOAD,
    jobsTake: OWNER_DAY_ROUTE_JOBS_TAKE,
    stops,
    includedStops,
    excludedStops,
    maps,
    readOnlyMessage: OWNER_DAY_ROUTE_READ_ONLY_MESSAGE,
    mapsDisclaimer: OWNER_DAY_ROUTE_MAPS_DISCLAIMER,
    orderNote: OWNER_DAY_ROUTE_ORDER_NOTE,
    excludedHeading: OWNER_DAY_ROUTE_EXCLUDED_HEADING,
  };
}

export function ownerDayRouteMapsContainsAddress(href: string | null, address: string) {
  if (!href || !address.trim()) return false;
  const encoded = encodeURIComponent(address.trim());
  return href.includes(encoded) || decodeURIComponent(href).includes(address.trim());
}

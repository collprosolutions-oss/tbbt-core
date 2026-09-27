import { FORBIDDEN_DAY_ROUTE_CLAIM_PATTERNS } from "@/lib/owner-day-route/constants";
import { ownerDayRouteExclusionLine } from "@/lib/owner-day-route/maps";
import type { OwnerDayRouteView } from "@/lib/owner-day-route/types";

export function ownerDayRouteTextHasForbiddenClaim(text: string) {
  return FORBIDDEN_DAY_ROUTE_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

export function ownerDayRouteViewText(view: OwnerDayRouteView) {
  return [
    view.readOnlyMessage,
    view.mapsDisclaimer,
    view.orderNote,
    view.excludedHeading,
    ...view.excludedStops.map(ownerDayRouteExclusionLine),
    ...view.stops.flatMap((stop) => [
      stop.customerName,
      stop.appointmentWindowLabel,
      stop.address,
      stop.exclusionLabel,
      stop.materialPickup.durationLabel,
      stop.materialPickup.blockLabel,
      stop.materialPickup.scheduledNote,
    ]),
  ]
    .filter(Boolean)
    .join("\n");
}

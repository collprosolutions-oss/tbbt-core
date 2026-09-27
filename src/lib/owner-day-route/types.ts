import type { MaterialPickupVisibility } from "@/lib/owner-today";

export type OwnerDayRouteProperty = {
  id: string;
  businessId: string;
  addressLine1: string;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
};

export type OwnerDayRouteJobRecord = {
  id: string;
  businessId: string;
  customerId?: string | null;
  status: string;
  scheduledAt: Date | null;
  scheduledDurationMinutes: number | null;
  arrivalWindowMinutes?: number | null;
  pickupDurationMinutes?: number | null;
  customer?: { id?: string | null; name: string | null } | null;
  property?: OwnerDayRouteProperty | null;
};

export type OwnerDayRouteExclusionReason =
  | "NO_PROPERTY"
  | "FOREIGN_PROPERTY"
  | "INCOMPLETE_ADDRESS";

export type OwnerDayRouteStop = {
  jobId: string;
  businessId: string;
  sequence: number;
  customerName: string;
  status: string;
  scheduledAt: Date;
  appointmentWindowLabel: string | null;
  materialPickup: MaterialPickupVisibility;
  includedInMaps: boolean;
  exclusionReason: OwnerDayRouteExclusionReason | null;
  exclusionLabel: string | null;
  address: string | null;
  mapsQuery: string | null;
  jobHref: string;
};

export type OwnerDayRouteMapsHandoff = {
  href: string | null;
  includedStopCount: number;
  omittedCompleteStopCount: number;
  truncated: boolean;
  addresses: string[];
};

export type OwnerDayRouteView = {
  businessId: string;
  dateIso: string;
  dayLabel: string;
  timeZone: string;
  readOnly: true;
  mutationsOnLoad: false;
  jobsTake: number;
  stops: OwnerDayRouteStop[];
  includedStops: OwnerDayRouteStop[];
  excludedStops: OwnerDayRouteStop[];
  maps: OwnerDayRouteMapsHandoff;
  readOnlyMessage: string;
  mapsDisclaimer: string;
  orderNote: string;
  excludedHeading: string;
};

export type OwnerDayRouteScheduleSnapshot = {
  jobId: string;
  scheduledAt: string | null;
  status: string;
  pickupDurationMinutes: number | null;
  arrivalWindowMinutes: number | null;
  assignedMembershipId: string | null;
};

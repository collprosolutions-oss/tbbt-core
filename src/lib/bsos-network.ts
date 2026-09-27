/**
 * BSOS Network — default-off, OWNER-opted public listing.
 *
 * Discovery may show only the approved public name, trade, broad service
 * area, and the one contact method the OWNER chose. Customers, jobs,
 * finances, private contacts, and inferred participation are never
 * disclosed. This is not a referral or matching engine.
 */

export const BSOS_NETWORK_PATH = "/network";

export const NETWORK_CONTACT_METHODS = ["PHONE", "EMAIL", "WEBSITE"] as const;
export type NetworkContactMethod = (typeof NETWORK_CONTACT_METHODS)[number];

export const PUBLIC_LISTING_FIELDS = [
  "listingId",
  "publicName",
  "trade",
  "serviceArea",
  "contactMethod",
  "contactValue",
] as const;
export type PublicListingField = (typeof PUBLIC_LISTING_FIELDS)[number];

export type PublicNetworkListing = {
  listingId: string;
  publicName: string;
  trade: string;
  serviceArea: string;
  contactMethod: NetworkContactMethod;
  contactValue: string;
};

export const DISCOVERY_LIMIT = 50;
export const MAX_PUBLIC_NAME_LENGTH = 120;
export const MAX_SERVICE_AREA_LENGTH = 120;

export const NETWORK_DEFAULT_OFF_MESSAGE =
  "BSOS Network is default-off. Other businesses cannot see this listing until the owner opts in.";
export const NETWORK_OPT_OUT_MESSAGE =
  "This business is no longer listed. Opt-out is immediate and does not tell anyone that you left.";
export const NETWORK_PRIVACY_MESSAGE =
  "Discovery shows only the approved public business name, trade, broad service area, and the contact method you choose. Customers, jobs, finances, private contacts, and businesses that have not opted in are never shown.";
export const NETWORK_NO_MATCHING_MESSAGE =
  "This is not a referral or automatic matching engine. Listings are not ranked or paired.";
export const NETWORK_OWNER_ONLY_MESSAGE = "Only the owner can opt this business into the network.";
export const NETWORK_NOT_IN_NAV_MESSAGE =
  "BSOS Network is not in the main navigation. Open /network to manage participation.";

export function isNetworkContactMethod(value: string | null | undefined): value is NetworkContactMethod {
  return (NETWORK_CONTACT_METHODS as readonly string[]).includes(value ?? "");
}

export function parseNetworkContactMethod(value: string | null | undefined): NetworkContactMethod {
  const normalized = value?.trim().toUpperCase() ?? "";
  if (!isNetworkContactMethod(normalized)) {
    throw new Error("Choose a public contact method: phone, email, or website.");
  }
  return normalized;
}

export function parseApprovedPublicName(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new Error("Enter the public business name you want listed.");
  }
  if (trimmed.length > MAX_PUBLIC_NAME_LENGTH) {
    throw new Error("Public business name is too long.");
  }
  return trimmed;
}

export function parseBroadServiceArea(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new Error("Enter a broad service area, such as a city and region.");
  }
  if (trimmed.length > MAX_SERVICE_AREA_LENGTH) {
    throw new Error("Service area is too long.");
  }
  return trimmed;
}

export const PUBLIC_LISTING_SELECT = {
  id: true,
  publicName: true,
  tradeCode: true,
  serviceAreaLabel: true,
  publicContactMethod: true,
  publicContactValue: true,
} as const;

type ListingRow = {
  id: string;
  publicName: string;
  tradeCode: string;
  serviceAreaLabel: string;
  publicContactMethod: string;
  publicContactValue: string;
};

/**
 * Maps a stored opted-in row to the only fields discovery may return.
 * Extra Prisma columns are dropped here so a future SELECT cannot leak
 * businessId, opt-out timestamps, or actor membership.
 */
export function toPublicListing(row: ListingRow): PublicNetworkListing {
  return {
    listingId: row.id,
    publicName: row.publicName,
    trade: row.tradeCode,
    serviceArea: row.serviceAreaLabel,
    contactMethod: isNetworkContactMethod(row.publicContactMethod)
      ? row.publicContactMethod
      : "EMAIL",
    contactValue: row.publicContactValue,
  };
}

export function listingFieldNames(listing: PublicNetworkListing): string[] {
  return Object.keys(listing).sort();
}

export function publicListingFieldNames(): string[] {
  return [...PUBLIC_LISTING_FIELDS].sort();
}

const HIDDEN_KEYS = [
  "businessId",
  "optedIn",
  "optedInAt",
  "optedOutAt",
  "updatedByMembershipId",
  "customer",
  "customers",
  "job",
  "jobs",
  "invoice",
  "invoices",
  "finance",
  "slug",
  "email",
  "phone",
  "publicPhone",
  "publicEmail",
  "operationalSmsNumber",
] as const;

export function listingHasHiddenFields(listing: object): boolean {
  return HIDDEN_KEYS.some((key) => Object.prototype.hasOwnProperty.call(listing, key));
}

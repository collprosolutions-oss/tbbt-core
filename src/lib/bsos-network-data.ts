/**
 * Tenant-safe BSOS Network loader.
 *
 * Own participation is scoped to BusinessAccess.businessId.
 * Discovery queries only optedIn=true rows and projects the public
 * listing allowlist. A missing or opted-out business is indistinguishable
 * from an unknown listing — never a "not participating" result.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { listActiveTradeCodes } from "@/lib/business-trades";
import {
  DISCOVERY_LIMIT,
  PUBLIC_LISTING_SELECT,
  isNetworkContactMethod,
  toPublicListing,
  type PublicNetworkListing,
} from "@/lib/bsos-network";
import { requireNetworkRead } from "@/lib/bsos-network-ops";
import { ensureBsosNetworkSchema } from "@/lib/bsos-network-schema";
import { isConfiguredTrade, tradeLabel } from "@/lib/trades";

type Db = PrismaClient | Prisma.TransactionClient;

export type OwnNetworkParticipation = {
  optedIn: boolean;
  listing: PublicNetworkListing | null;
};

export type NetworkSuggestions = {
  publicName: string;
  trades: Array<{ code: string; label: string }>;
  serviceArea: string;
  contacts: Array<{ method: "PHONE" | "EMAIL" | "WEBSITE"; value: string }>;
};

export type NetworkDiscoveryQuery = {
  trade?: string | null;
  serviceArea?: string | null;
};

export type NetworkWorkspace = {
  own: OwnNetworkParticipation;
  suggestions: NetworkSuggestions;
  listings: PublicNetworkListing[];
};

function parseDiscoveryTrade(value: string | null | undefined) {
  const trimmed = value?.trim().toUpperCase() ?? "";
  if (!trimmed) return undefined;
  return isConfiguredTrade(trimmed) ? trimmed : undefined;
}

function parseDiscoveryArea(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed.slice(0, 120) : undefined;
}

export async function loadOwnNetworkParticipation(
  db: Db,
  access: BusinessAccess,
): Promise<OwnNetworkParticipation> {
  requireNetworkRead(access);
  await ensureBsosNetworkSchema(db);

  const row = await db.bsosNetworkParticipation.findFirst({
    where: { businessId: access.businessId },
    select: {
      ...PUBLIC_LISTING_SELECT,
      optedIn: true,
    },
  });

  if (!row || !row.optedIn) {
    return { optedIn: false, listing: null };
  }

  return { optedIn: true, listing: toPublicListing(row) };
}

export async function discoverPublicNetworkListings(
  db: Db,
  access: BusinessAccess,
  query: NetworkDiscoveryQuery = {},
): Promise<PublicNetworkListing[]> {
  requireNetworkRead(access);
  await ensureBsosNetworkSchema(db);

  const trade = parseDiscoveryTrade(query.trade);
  const serviceArea = parseDiscoveryArea(query.serviceArea);

  const rows = await db.bsosNetworkParticipation.findMany({
    where: {
      optedIn: true,
      ...(trade ? { tradeCode: trade } : {}),
      ...(serviceArea
        ? { serviceAreaLabel: { contains: serviceArea, mode: "insensitive" } }
        : {}),
    },
    select: PUBLIC_LISTING_SELECT,
    orderBy: { publicName: "asc" },
    take: DISCOVERY_LIMIT,
  });

  return rows.map(toPublicListing);
}

/**
 * Lookup by listing id only. Unknown and opted-out ids both return null
 * so callers cannot infer that a known business exists but stayed off.
 */
export async function findPublicNetworkListing(
  db: Db,
  access: BusinessAccess,
  listingId: string,
): Promise<PublicNetworkListing | null> {
  requireNetworkRead(access);
  await ensureBsosNetworkSchema(db);

  const trimmed = listingId.trim();
  if (!trimmed) return null;

  const row = await db.bsosNetworkParticipation.findFirst({
    where: { id: trimmed, optedIn: true },
    select: PUBLIC_LISTING_SELECT,
  });
  return row ? toPublicListing(row) : null;
}

export async function loadNetworkSuggestions(
  db: Db,
  access: BusinessAccess,
): Promise<NetworkSuggestions> {
  requireNetworkRead(access);

  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: {
      name: true,
      publicPhone: true,
      publicEmail: true,
      publicWebsite: true,
      publicServiceAreaLabel: true,
    },
  });
  const trades = await listActiveTradeCodes(db, access.businessId);
  const contacts: NetworkSuggestions["contacts"] = [];
  if (business?.publicPhone?.trim()) {
    contacts.push({ method: "PHONE", value: business.publicPhone.trim() });
  }
  if (business?.publicEmail?.trim()) {
    contacts.push({ method: "EMAIL", value: business.publicEmail.trim() });
  }
  if (business?.publicWebsite?.trim()) {
    contacts.push({ method: "WEBSITE", value: business.publicWebsite.trim() });
  }

  return {
    publicName: business?.name?.trim() ?? "",
    trades: trades.map((code) => ({ code, label: tradeLabel(code) })),
    serviceArea: business?.publicServiceAreaLabel?.trim() ?? "",
    contacts,
  };
}

export async function loadNetworkWorkspace(
  db: Db,
  access: BusinessAccess,
  query: NetworkDiscoveryQuery = {},
): Promise<NetworkWorkspace> {
  requireNetworkRead(access);
  const [own, suggestions, listings] = await Promise.all([
    loadOwnNetworkParticipation(db, access),
    loadNetworkSuggestions(db, access),
    discoverPublicNetworkListings(db, access, query),
  ]);
  return { own, suggestions, listings };
}

export function suggestedContactMethod(suggestions: NetworkSuggestions) {
  const first = suggestions.contacts[0];
  return first && isNetworkContactMethod(first.method) ? first.method : "EMAIL";
}

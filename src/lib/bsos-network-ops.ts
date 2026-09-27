/**
 * BSOS Network mutations. OWNER explicitly opts a business in or out.
 * Tenant scope always comes from BusinessAccess. MEMBER never reads or
 * writes participation. Discovery of other tenants is a separate loader.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import { listActiveTradeCodes } from "@/lib/business-trades";
import {
  parsePublicEmail,
  parsePublicPhone,
  parsePublicWebsite,
} from "@/lib/business-contact";
import {
  parseApprovedPublicName,
  parseBroadServiceArea,
  parseNetworkContactMethod,
  type NetworkContactMethod,
} from "@/lib/bsos-network";
import { ensureBsosNetworkSchema } from "@/lib/bsos-network-schema";
import { isConfiguredTrade } from "@/lib/trades";

type Db = PrismaClient | Prisma.TransactionClient;

export class BsosNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BsosNetworkError";
  }
}

export function bsosNetworkErrorMessage(error: unknown, fallback: string) {
  if (error instanceof BsosNetworkError || error instanceof ForbiddenError) {
    return error.message;
  }
  if (error instanceof Error && /valid phone|valid email|website URL|Service area/i.test(error.message)) {
    return error.message;
  }
  return fallback;
}

export function requireNetworkRead(access: BusinessAccess) {
  if (access.workspace.role === "MEMBER") {
    throw new ForbiddenError();
  }
}

export function requireNetworkOwner(access: BusinessAccess) {
  requireBusinessRole(access, "OWNER");
}

function parseChosenContactValue(method: NetworkContactMethod, value: string) {
  if (method === "PHONE") {
    const phone = parsePublicPhone(value);
    if (!phone) throw new BsosNetworkError("Enter the public phone number you want listed.");
    return phone;
  }
  if (method === "EMAIL") {
    const email = parsePublicEmail(value);
    if (!email) throw new BsosNetworkError("Enter the public email you want listed.");
    return email;
  }
  const website = parsePublicWebsite(value);
  if (!website) throw new BsosNetworkError("Enter the public website you want listed.");
  return website;
}

async function resolveListingTrade(db: Db, access: BusinessAccess, requested: string) {
  const trade = requested.trim().toUpperCase();
  if (!isConfiguredTrade(trade)) {
    throw new BsosNetworkError("Choose a configured trade.");
  }
  const active = await listActiveTradeCodes(db, access.businessId);
  if (!active.includes(trade)) {
    throw new BsosNetworkError("Choose one of this business's active trades.");
  }
  return trade;
}

export type OptInInput = {
  publicName: string;
  tradeCode: string;
  serviceAreaLabel: string;
  publicContactMethod: string;
  publicContactValue: string;
};

export async function optBusinessIntoNetwork(db: Db, access: BusinessAccess, input: OptInInput) {
  requireNetworkOwner(access);
  await ensureBsosNetworkSchema(db);

  const publicName = parseApprovedPublicName(input.publicName);
  const tradeCode = await resolveListingTrade(db, access, input.tradeCode);
  const serviceAreaLabel = parseBroadServiceArea(input.serviceAreaLabel);
  const publicContactMethod = parseNetworkContactMethod(input.publicContactMethod);
  const publicContactValue = parseChosenContactValue(publicContactMethod, input.publicContactValue);
  const now = new Date();

  const existing = await db.bsosNetworkParticipation.findFirst({
    where: { businessId: access.businessId },
    select: { id: true, optedIn: true, optedInAt: true },
  });

  const data = {
    publicName,
    tradeCode,
    serviceAreaLabel,
    publicContactMethod,
    publicContactValue,
    optedIn: true,
    optedInAt: existing?.optedIn && existing.optedInAt ? existing.optedInAt : now,
    optedOutAt: null,
    updatedByMembershipId: access.workspace.membership.id,
  };

  if (existing) {
    return db.bsosNetworkParticipation.update({
      where: { id: existing.id },
      data,
    });
  }

  return db.bsosNetworkParticipation.create({
    data: {
      businessId: access.businessId,
      ...data,
    },
  });
}

export async function optBusinessOutOfNetwork(db: Db, access: BusinessAccess) {
  requireNetworkOwner(access);
  await ensureBsosNetworkSchema(db);

  const existing = await db.bsosNetworkParticipation.findFirst({
    where: { businessId: access.businessId },
    select: { id: true, optedIn: true },
  });
  if (!existing) {
    return null;
  }
  if (!existing.optedIn) {
    return db.bsosNetworkParticipation.findFirst({
      where: { id: existing.id },
    });
  }

  return db.bsosNetworkParticipation.update({
    where: { id: existing.id },
    data: {
      optedIn: false,
      optedOutAt: new Date(),
      updatedByMembershipId: access.workspace.membership.id,
    },
  });
}

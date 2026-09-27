/**
 * Business Location mutations. OWNER creates, updates, and archives.
 * Tenant scope always comes from BusinessAccess. MEMBER never reads or
 * writes the office directory. Creating a location writes only a
 * BusinessLocation row — never timezone, Stripe, service areas, or jobs.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import { ensureBusinessLocationSchema } from "@/lib/business-location-schema";
import {
  parseLocationAddressInput,
  parseLocationName,
  toRecordedBusinessLocation,
  type RecordedBusinessLocation,
} from "@/lib/business-locations";
import { writeSettingsAuditLog } from "@/lib/settings-ops";

type Db = PrismaClient | Prisma.TransactionClient;

export class BusinessLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessLocationError";
  }
}

export function businessLocationErrorMessage(error: unknown, fallback: string) {
  if (error instanceof BusinessLocationError || error instanceof ForbiddenError) {
    return error.message;
  }
  if (error instanceof Error && /location|address|characters or fewer/i.test(error.message)) {
    return error.message;
  }
  return fallback;
}

export function requireLocationRead(access: BusinessAccess) {
  if (access.workspace.role === "MEMBER") {
    throw new ForbiddenError();
  }
}

export function requireLocationOwner(access: BusinessAccess) {
  requireBusinessRole(access, "OWNER");
}

export async function listBusinessLocations(db: Db, access: BusinessAccess) {
  requireLocationRead(access);
  await ensureBusinessLocationSchema(db);
  const rows = await db.businessLocation.findMany({
    where: { businessId: access.businessId },
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });
  return rows.map(toRecordedBusinessLocation);
}

type LocationWriteInput = {
  name: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  notes?: string;
};

function parseLocationWrite(input: LocationWriteInput) {
  try {
    return {
      name: parseLocationName(input.name),
      ...parseLocationAddressInput(input),
    };
  } catch (error) {
    throw new BusinessLocationError(
      error instanceof Error ? error.message : "That location could not be saved.",
    );
  }
}

export async function createBusinessLocation(
  db: PrismaClient,
  access: BusinessAccess,
  input: LocationWriteInput,
): Promise<RecordedBusinessLocation> {
  requireLocationOwner(access);
  await ensureBusinessLocationSchema(db);
  const data = parseLocationWrite(input);

  return db.$transaction(async (tx) => {
    const created = await tx.businessLocation.create({
      data: {
        ...data,
        businessId: access.businessId,
        status: "ACTIVE",
        createdByMembershipId: access.workspace.membership.id,
      },
    });
    await writeSettingsAuditLog(tx, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "locations",
      settingKey: "businessLocation.create",
      previousValue: null,
      newValue: { id: created.id, name: created.name },
    });
    return toRecordedBusinessLocation(created);
  });
}

export async function updateBusinessLocation(
  db: PrismaClient,
  access: BusinessAccess,
  input: LocationWriteInput & { locationId: string },
): Promise<RecordedBusinessLocation> {
  requireLocationOwner(access);
  await ensureBusinessLocationSchema(db);
  const existing = access.assertOwned(
    await db.businessLocation.findFirst({
      where: { id: input.locationId, ...access.scope },
    }),
  );
  const data = parseLocationWrite(input);

  return db.$transaction(async (tx) => {
    const updated = await tx.businessLocation.update({
      where: { id: existing.id },
      data,
    });
    await writeSettingsAuditLog(tx, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "locations",
      settingKey: "businessLocation.update",
      previousValue: { id: existing.id, name: existing.name },
      newValue: { id: updated.id, name: updated.name },
    });
    return toRecordedBusinessLocation(updated);
  });
}

export async function setBusinessLocationStatus(
  db: PrismaClient,
  access: BusinessAccess,
  input: { locationId: string; status: "ACTIVE" | "ARCHIVED" },
): Promise<RecordedBusinessLocation> {
  requireLocationOwner(access);
  await ensureBusinessLocationSchema(db);
  const existing = access.assertOwned(
    await db.businessLocation.findFirst({
      where: { id: input.locationId, ...access.scope },
    }),
  );

  return db.$transaction(async (tx) => {
    const updated = await tx.businessLocation.update({
      where: { id: existing.id },
      data: { status: input.status },
    });
    await writeSettingsAuditLog(tx, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "locations",
      settingKey: "businessLocation.status",
      previousValue: { id: existing.id, status: existing.status },
      newValue: { id: updated.id, status: updated.status },
    });
    return toRecordedBusinessLocation(updated);
  });
}

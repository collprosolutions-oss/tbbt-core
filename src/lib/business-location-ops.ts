/**
 * Business Location mutations. OWNER creates, updates, and archives.
 * Tenant scope always comes from BusinessAccess. MEMBER never reads or
 * writes the office directory. Creating a location writes only a
 * BusinessLocation row — never timezone, Stripe, service areas, or jobs.
 *
 * Schema comes only from Prisma migrate. Reads and writes never run DDL.
 * If Preview skipped migrate and the table is absent, the directory is
 * unavailable instead of creating schema.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import {
  BUSINESS_LOCATION_DIRECTORY_LIMIT,
  LOCATION_UNAVAILABLE_MESSAGE,
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

export class BusinessLocationUnavailableError extends BusinessLocationError {
  constructor(message = LOCATION_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "BusinessLocationUnavailableError";
  }
}

export function missingBusinessLocationSchema(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "P2021" ||
    code === "P2022" ||
    /BusinessLocation|businessLocationId|does not exist/i.test(message)
  );
}

function throwIfLocationSchemaMissing(error: unknown): never {
  if (missingBusinessLocationSchema(error)) {
    throw new BusinessLocationUnavailableError();
  }
  throw error;
}

export function businessLocationErrorMessage(error: unknown, fallback: string) {
  if (
    error instanceof BusinessLocationError ||
    error instanceof BusinessLocationUnavailableError ||
    error instanceof ForbiddenError
  ) {
    return error.message;
  }
  if (missingBusinessLocationSchema(error)) {
    return LOCATION_UNAVAILABLE_MESSAGE;
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

export type BusinessLocationDirectory = {
  available: boolean;
  locations: RecordedBusinessLocation[];
};

export async function listBusinessLocations(db: Db, access: BusinessAccess) {
  requireLocationRead(access);
  try {
    const rows = await db.businessLocation.findMany({
      where: { businessId: access.businessId },
      orderBy: [{ status: "asc" }, { name: "asc" }],
      take: BUSINESS_LOCATION_DIRECTORY_LIMIT,
    });
    return rows.map(toRecordedBusinessLocation);
  } catch (error) {
    throwIfLocationSchemaMissing(error);
  }
}

/**
 * Cleaning follow-ups may copy Job.businessLocationId onto a new Job
 * only when that location is still ACTIVE on the same business.
 * Archived, missing, or cross-tenant ids become null so the new Job
 * stays unassigned.
 */
export async function resolveCopyableBusinessLocationId(
  db: Db,
  businessId: string,
  locationId: string | null | undefined,
): Promise<string | null> {
  if (!locationId) return null;
  try {
    const row = await db.businessLocation.findFirst({
      where: { id: locationId, businessId, status: "ACTIVE" },
      select: { id: true },
    });
    return row?.id ?? null;
  } catch (error) {
    if (missingBusinessLocationSchema(error)) return null;
    throw error;
  }
}

export async function loadBusinessLocationDirectory(
  db: Db,
  access: BusinessAccess,
): Promise<BusinessLocationDirectory> {
  try {
    return { available: true, locations: await listBusinessLocations(db, access) };
  } catch (error) {
    if (error instanceof BusinessLocationUnavailableError || missingBusinessLocationSchema(error)) {
      return { available: false, locations: [] };
    }
    throw error;
  }
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
  const data = parseLocationWrite(input);

  try {
    return await db.$transaction(async (tx) => {
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
  } catch (error) {
    throwIfLocationSchemaMissing(error);
  }
}

export async function updateBusinessLocation(
  db: PrismaClient,
  access: BusinessAccess,
  input: LocationWriteInput & { locationId: string },
): Promise<RecordedBusinessLocation> {
  requireLocationOwner(access);
  let existing: { id: string; businessId: string; name: string };
  try {
    existing = access.assertOwned(
      await db.businessLocation.findFirst({
        where: { id: input.locationId, ...access.scope },
      }),
    );
  } catch (error) {
    throwIfLocationSchemaMissing(error);
  }
  const data = parseLocationWrite(input);

  try {
    return await db.$transaction(async (tx) => {
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
  } catch (error) {
    throwIfLocationSchemaMissing(error);
  }
}

export async function setBusinessLocationStatus(
  db: PrismaClient,
  access: BusinessAccess,
  input: { locationId: string; status: "ACTIVE" | "ARCHIVED" },
): Promise<RecordedBusinessLocation> {
  requireLocationOwner(access);
  let existing: { id: string; businessId: string; status: string };
  try {
    existing = access.assertOwned(
      await db.businessLocation.findFirst({
        where: { id: input.locationId, ...access.scope },
      }),
    );
  } catch (error) {
    throwIfLocationSchemaMissing(error);
  }

  try {
    return await db.$transaction(async (tx) => {
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
  } catch (error) {
    throwIfLocationSchemaMissing(error);
  }
}

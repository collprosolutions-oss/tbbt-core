import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  isServiceAreaKind,
  parseOptionalMoney,
  type RecordedServiceArea,
} from "@/lib/service-areas";

type Db = PrismaClient | Prisma.TransactionClient;

export class ServiceAreaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceAreaError";
  }
}

export function serviceAreaErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ServiceAreaError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

export function toRecordedServiceArea(row: {
  id: string;
  kind: string;
  label: string;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  enabled: boolean;
  travelAdjustment: { toNumber(): number } | number | null;
  minimumAdjustment: { toNumber(): number } | number | null;
  notes: string;
}): RecordedServiceArea {
  const travel =
    row.travelAdjustment == null
      ? null
      : typeof row.travelAdjustment === "number"
        ? row.travelAdjustment
        : row.travelAdjustment.toNumber();
  const minimum =
    row.minimumAdjustment == null
      ? null
      : typeof row.minimumAdjustment === "number"
        ? row.minimumAdjustment
        : row.minimumAdjustment.toNumber();
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    enabled: row.enabled,
    travelAdjustment: travel,
    minimumAdjustment: minimum,
    notes: row.notes,
  };
}

export async function listServiceAreas(db: Db, businessId: string) {
  const rows = await db.serviceArea.findMany({
    where: { businessId },
    orderBy: [{ enabled: "desc" }, { label: "asc" }],
  });
  return rows.map(toRecordedServiceArea);
}

export async function upsertServiceArea(
  db: Db,
  access: BusinessAccess,
  input: {
    areaId?: string;
    kind: string;
    label: string;
    city?: string;
    region?: string;
    postalCode?: string;
    enabled?: boolean;
    travelAdjustment?: string;
    minimumAdjustment?: string;
    notes?: string;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  if (!isServiceAreaKind(input.kind)) throw new ServiceAreaError("Choose City or ZIP / postal.");
  const label = input.label.trim();
  if (!label) throw new ServiceAreaError("A service area needs a label.");
  const travel = parseOptionalMoney(input.travelAdjustment);
  const minimum = parseOptionalMoney(input.minimumAdjustment);
  if (Number.isNaN(travel) || Number.isNaN(minimum)) {
    throw new ServiceAreaError("Travel and minimum adjustments must be zero or a positive amount.");
  }
  const data = {
    kind: input.kind,
    label,
    city: input.city?.trim() || null,
    region: input.region?.trim() || null,
    postalCode: input.postalCode?.trim() || null,
    enabled: input.enabled !== false,
    travelAdjustment: travel,
    minimumAdjustment: minimum,
    notes: input.notes?.trim() ?? "",
  };
  if (input.areaId) {
    const existing = access.assertOwned(
      await db.serviceArea.findFirst({
        where: { id: input.areaId, ...access.scope },
      }),
    );
    return toRecordedServiceArea(
      await db.serviceArea.update({
        where: { id: existing.id },
        data,
      }),
    );
  }
  return toRecordedServiceArea(
    await db.serviceArea.create({
      data: {
        ...data,
        businessId: access.businessId,
        createdByMembershipId: access.workspace.membership.id,
      },
    }),
  );
}

export async function setServiceAreaEnabled(
  db: Db,
  access: BusinessAccess,
  input: { areaId: string; enabled: boolean },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  const existing = access.assertOwned(
    await db.serviceArea.findFirst({
      where: { id: input.areaId, ...access.scope },
    }),
  );
  return toRecordedServiceArea(
    await db.serviceArea.update({
      where: { id: existing.id },
      data: { enabled: input.enabled },
    }),
  );
}

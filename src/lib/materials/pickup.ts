/**
 * Material pickup requirements as data for scheduling (#105) and
 * assigned-worker pickup recording. This module reuses MaterialPurchaseList
 * / MaterialPurchaseListItem. It does not purchase items, alter supplier
 * prices, create expenses, start MATERIAL_PICKUP time, or rewrite job
 * calendar / availability architecture.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import type { FieldWorkspace } from "@/lib/field-access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { assertFieldPickupJob } from "@/lib/materials/access";
import { MaterialsError } from "@/lib/materials/errors";
import { parseNonNegativeDecimal } from "@/lib/materials/money";
import {
  isPickupException,
  isPurchaseItemStatus,
  PICKUP_EXCEPTION_LABELS,
  type FieldJobPickupView,
  type JobMaterialPickupRequirement,
  type PickupException,
} from "@/lib/materials/types";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";

type Db = PrismaClient | Prisma.TransactionClient;

export type AssignedPickupActor = Pick<FieldWorkspace, "businessId" | "membershipId">;

export const ASSIGNED_PICKUP_ONLY_MESSAGE =
  "You can only record pickup on a job assigned to you.";
export const PICKUP_ITEM_NOT_ON_JOB = "That pickup item is not on this job.";
export const PICKUP_CHOOSE_QUANTITY_OR_EXCEPTION =
  "Enter a picked-up quantity or an exception.";
export const PICKUP_INVALID_EXCEPTION = "Choose a valid pickup exception.";
export const PICKUP_OTHER_NEEDS_NOTE = "Enter a note for that exception.";
export const PICKUP_ZERO_NEEDS_EXCEPTION = "A zero quantity needs an exception.";
export const PICKUP_INVALID_QUANTITY = "Picked-up quantity must be zero or greater.";

const PICKUP_EXCEPTION_NOTE_MAX_CHARS = 280;

type PurchaseListItemPickupRow = {
  id: string;
  name: string;
  quantityNeeded: Prisma.Decimal;
  unit: string;
  pickupRequired: boolean;
  pickupLocationDescription: string | null;
  pickupDurationMinutes: number | null;
  pickupReady: boolean;
  status: string;
  quantityPickedUp: Prisma.Decimal | null;
  pickupException: string | null;
  pickupExceptionNote: string | null;
  pickupRecordedAt: Date | null;
  supplier: { name: string; locationDescription: string | null } | null;
};

const PICKUP_ITEM_SELECT = {
  id: true,
  name: true,
  quantityNeeded: true,
  unit: true,
  pickupRequired: true,
  pickupLocationDescription: true,
  pickupDurationMinutes: true,
  pickupReady: true,
  status: true,
  quantityPickedUp: true,
  pickupException: true,
  pickupExceptionNote: true,
  pickupRecordedAt: true,
  supplier: { select: { name: true, locationDescription: true } },
} as const;

export function pickupExceptionLabel(value: string | null | undefined) {
  return isPickupException(value) ? PICKUP_EXCEPTION_LABELS[value] : null;
}

function resolvedPickupException(value: string | null | undefined): PickupException | null {
  return isPickupException(value) ? value : null;
}

function toFieldJobPickupView(item: PurchaseListItemPickupRow): FieldJobPickupView {
  const pickupException = resolvedPickupException(item.pickupException);
  return {
    id: item.id,
    name: item.name,
    quantityNeeded: item.quantityNeeded.toString(),
    unit: item.unit,
    supplierName: item.supplier?.name ?? null,
    pickupRequired: true,
    pickupLocationDescription:
      item.pickupLocationDescription ?? item.supplier?.locationDescription ?? null,
    pickupDurationMinutes: item.pickupDurationMinutes,
    pickupReady: item.pickupReady,
    status: isPurchaseItemStatus(item.status) ? item.status : "NEEDED",
    quantityPickedUp: item.quantityPickedUp?.toString() ?? null,
    pickupException,
    pickupExceptionLabel: pickupExceptionLabel(pickupException),
    pickupExceptionNote: item.pickupExceptionNote,
    pickupRecorded: item.quantityPickedUp != null || pickupException != null,
  };
}

export async function listJobMaterialPickupRequirements(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<JobMaterialPickupRequirement[]> {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  access.assertOwned(
    await db.job.findFirst({
      where: { id: jobId, businessId: access.businessId },
      select: { id: true, businessId: true },
    }),
  );
  const items = await db.materialPurchaseListItem.findMany({
    where: {
      businessId: access.businessId,
      pickupRequired: true,
      status: { not: "CANCELLED" },
      purchaseList: { jobId },
    },
    include: { supplier: { select: { name: true, locationDescription: true } } },
    orderBy: { createdAt: "asc" },
  });
  return items.map((item) => ({
    jobId,
    purchaseListItemId: item.id,
    name: item.name,
    quantityNeeded: Number(item.quantityNeeded.toString()),
    unit: item.unit,
    supplierName: item.supplier?.name ?? null,
    locationDescription:
      item.pickupLocationDescription ?? item.supplier?.locationDescription ?? null,
    durationMinutes: item.pickupDurationMinutes,
    ready: item.pickupReady,
    status: isPurchaseItemStatus(item.status) ? item.status : "NEEDED",
    quantityPickedUp:
      item.quantityPickedUp == null ? null : Number(item.quantityPickedUp.toString()),
    pickupException: resolvedPickupException(item.pickupException),
    pickupExceptionNote: item.pickupExceptionNote,
    pickupRecordedAt: item.pickupRecordedAt?.toISOString() ?? null,
  }));
}

export async function listAssignedJobPickupView(
  db: Db,
  field: AssignedPickupActor,
  jobId: string,
): Promise<FieldJobPickupView[]> {
  await assertFieldPickupJob(db, field, jobId);
  const items = await db.materialPurchaseListItem.findMany({
    where: {
      businessId: field.businessId,
      pickupRequired: true,
      status: { not: "CANCELLED" },
      purchaseList: { jobId, businessId: field.businessId },
    },
    select: PICKUP_ITEM_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return items.map(toFieldJobPickupView);
}

export type RecordAssignedJobPickupInput = {
  jobId: string;
  itemId: string;
  quantityPickedUp?: string | number | null;
  pickupException?: string | null;
  pickupExceptionNote?: string | null;
  /** Proof hook: runs after the authorize read and before the Job lock. */
  afterInitialRead?: () => Promise<void>;
};

export type RecordAssignedJobPickupResult = {
  alreadyRecorded: boolean;
  item: FieldJobPickupView;
};

function normalizePickupExceptionNote(raw: unknown) {
  if (raw == null) return null;
  if (typeof raw !== "string") {
    throw new MaterialsError(PICKUP_CHOOSE_QUANTITY_OR_EXCEPTION);
  }
  const note = raw.trim();
  if (!note) return null;
  if (note.length > PICKUP_EXCEPTION_NOTE_MAX_CHARS) {
    throw new MaterialsError(
      `Keep the exception note under ${PICKUP_EXCEPTION_NOTE_MAX_CHARS} characters.`,
    );
  }
  return note;
}

function resolvePickupRecordFields(input: {
  quantityPickedUp?: string | number | null;
  pickupException?: string | null;
  pickupExceptionNote?: string | null;
}) {
  const quantityProvided =
    input.quantityPickedUp != null && String(input.quantityPickedUp).trim() !== "";
  let quantityPickedUp: Prisma.Decimal | null = null;
  if (quantityProvided) {
    const parsed = parseNonNegativeDecimal(input.quantityPickedUp);
    if (!parsed) {
      throw new MaterialsError(PICKUP_INVALID_QUANTITY);
    }
    quantityPickedUp = parsed.toDecimalPlaces(4);
  }

  const rawException =
    typeof input.pickupException === "string" ? input.pickupException.trim() : "";
  if (rawException && !isPickupException(rawException)) {
    throw new MaterialsError(PICKUP_INVALID_EXCEPTION);
  }
  const pickupException = isPickupException(rawException) ? rawException : null;
  const pickupExceptionNote = normalizePickupExceptionNote(input.pickupExceptionNote);

  if (!quantityPickedUp && !pickupException) {
    throw new MaterialsError(PICKUP_CHOOSE_QUANTITY_OR_EXCEPTION);
  }
  if (quantityPickedUp?.isZero() && !pickupException) {
    throw new MaterialsError(PICKUP_ZERO_NEEDS_EXCEPTION);
  }
  if (pickupException === "OTHER" && !pickupExceptionNote) {
    throw new MaterialsError(PICKUP_OTHER_NEEDS_NOTE);
  }

  return { quantityPickedUp, pickupException, pickupExceptionNote };
}

function samePickupRecord(
  existing: {
    quantityPickedUp: Prisma.Decimal | null;
    pickupException: string | null;
    pickupExceptionNote: string | null;
  },
  next: {
    quantityPickedUp: Prisma.Decimal | null;
    pickupException: PickupException | null;
    pickupExceptionNote: string | null;
  },
) {
  const sameQuantity =
    existing.quantityPickedUp == null && next.quantityPickedUp == null
      ? true
      : existing.quantityPickedUp != null &&
        next.quantityPickedUp != null &&
        existing.quantityPickedUp.eq(next.quantityPickedUp);
  return (
    sameQuantity &&
    (existing.pickupException ?? null) === next.pickupException &&
    (existing.pickupExceptionNote ?? null) === next.pickupExceptionNote
  );
}

async function lockTenantOwnedPurchaseListItem(
  db: Db,
  businessId: string,
  itemId: string,
) {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "MaterialPurchaseListItem"
    WHERE id = ${itemId}
      AND "businessId" = ${businessId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export async function recordAssignedJobPickup(
  db: PrismaClient,
  actor: AssignedPickupActor,
  input: RecordAssignedJobPickupInput,
): Promise<RecordAssignedJobPickupResult> {
  const fields = resolvePickupRecordFields(input);
  const job = await assertFieldPickupJob(db, actor, input.jobId);
  const existing = await db.materialPurchaseListItem.findFirst({
    where: {
      id: input.itemId,
      businessId: actor.businessId,
      pickupRequired: true,
      status: { not: "CANCELLED" },
      purchaseList: { jobId: job.id, businessId: actor.businessId },
    },
    select: {
      id: true,
      quantityPickedUp: true,
      pickupException: true,
      pickupExceptionNote: true,
    },
  });
  if (!existing) {
    throw new MaterialsError(PICKUP_ITEM_NOT_ON_JOB);
  }

  if (input.afterInitialRead) {
    await input.afterInitialRead();
  }

  return db.$transaction(async (tx) => {
    const lockedJob = await lockTenantOwnedJob(tx, actor.businessId, job.id);
    if (!lockedJob || lockedJob.assignedMembershipId !== actor.membershipId) {
      throw new MaterialsError(ASSIGNED_PICKUP_ONLY_MESSAGE);
    }

    const lockedItemId = await lockTenantOwnedPurchaseListItem(
      tx,
      actor.businessId,
      existing.id,
    );
    if (!lockedItemId) {
      throw new MaterialsError(PICKUP_ITEM_NOT_ON_JOB);
    }

    const lockedItem = await tx.materialPurchaseListItem.findFirst({
      where: {
        id: existing.id,
        businessId: actor.businessId,
        pickupRequired: true,
        status: { not: "CANCELLED" },
        purchaseList: { jobId: lockedJob.id, businessId: actor.businessId },
      },
      select: PICKUP_ITEM_SELECT,
    });
    if (!lockedItem) {
      throw new MaterialsError(PICKUP_ITEM_NOT_ON_JOB);
    }

    if (
      samePickupRecord(lockedItem, fields) &&
      lockedItem.pickupRecordedAt != null
    ) {
      return { alreadyRecorded: true, item: toFieldJobPickupView(lockedItem) };
    }

    const updated = await tx.materialPurchaseListItem.update({
      where: { id: lockedItem.id },
      data: {
        quantityPickedUp: fields.quantityPickedUp,
        pickupException: fields.pickupException,
        pickupExceptionNote: fields.pickupExceptionNote,
        pickupRecordedAt: new Date(),
        pickupRecordedByMembershipId: actor.membershipId,
      },
      select: PICKUP_ITEM_SELECT,
    });

    return { alreadyRecorded: false, item: toFieldJobPickupView(updated) };
  });
}

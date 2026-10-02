/**
 * Equipment register writes. OWNER records items and maintenance.
 * ADMIN may only read. MEMBER is denied — field work stays on
 * assigned-job field permissions. businessId always comes from
 * BusinessAccess. Schema comes only from Prisma migrate.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError } from "@/lib/authorization";
import { REPORTED_EXPENSE_WHERE } from "@/lib/expenses";
import {
  equipmentActorMembershipId,
  requireEquipmentWrite,
} from "@/lib/equipment/access";
import {
  EQUIPMENT_KINDS,
  EQUIPMENT_KIND_LABELS,
  EQUIPMENT_PURCHASE_CATEGORIES,
  EQUIPMENT_UNAVAILABLE_MESSAGE,
  MAX_ATTEMPT_KEY_LENGTH,
  MAX_EQUIPMENT_NAME_LENGTH,
  MAX_EQUIPMENT_NOTES_LENGTH,
  MAX_MAINTENANCE_NOTES_LENGTH,
  type EquipmentKind,
} from "@/lib/equipment/constants";
import {
  equipmentTimeZone,
  optionalEquipmentDate,
  requireEquipmentDate,
} from "@/lib/equipment/dates";

type Db = PrismaClient | Prisma.TransactionClient;

export class EquipmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EquipmentError";
  }
}

export class EquipmentUnavailableError extends EquipmentError {
  constructor(message = EQUIPMENT_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "EquipmentUnavailableError";
  }
}

function prismaErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: string }).code)
    : "";
}

export function isDuplicateEquipmentAttemptError(error: unknown) {
  return prismaErrorCode(error) === "P2002";
}

/**
 * Test-only barrier. Production never sets this.
 * beforeItemInsert runs after the existing-row lookup and before create,
 * so concurrent duplicate submits can meet before either insert.
 */
export const equipmentRegisterTestHooks: {
  beforeItemInsert?: (input: {
    businessId: string;
    attemptKey: string;
  }) => Promise<void> | void;
} = {};

export function missingEquipmentSchema(error: unknown) {
  const code = prismaErrorCode(error);
  if (code === "P2002") return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "P2021" ||
    code === "P2022" ||
    /EquipmentItem|EquipmentMaintenanceEntry|equipmentItem|does not exist/i.test(message)
  );
}

function throwIfEquipmentSchemaMissing(error: unknown): never {
  if (missingEquipmentSchema(error)) {
    throw new EquipmentUnavailableError();
  }
  throw error;
}

export function equipmentErrorMessage(error: unknown, fallback: string) {
  if (
    error instanceof EquipmentError ||
    error instanceof EquipmentUnavailableError ||
    error instanceof ForbiddenError
  ) {
    return error.message;
  }
  if (missingEquipmentSchema(error)) {
    return EQUIPMENT_UNAVAILABLE_MESSAGE;
  }
  if (
    error instanceof Error &&
    /equipment|service date|maintenance|purchase|characters or fewer|YYYY-MM-DD|attempt/i.test(
      error.message,
    )
  ) {
    return error.message;
  }
  return fallback;
}

export function isEquipmentKind(value: string | undefined): value is EquipmentKind {
  return (EQUIPMENT_KINDS as readonly string[]).includes(value ?? "");
}

function trimField(value: string | undefined, max: number, label: string) {
  const next = (value ?? "").trim();
  if (next.length > max) {
    throw new EquipmentError(`${label} must be ${max} characters or fewer.`);
  }
  return next;
}

export function parseEquipmentName(value: string | undefined) {
  const name = trimField(value, MAX_EQUIPMENT_NAME_LENGTH, "Name");
  if (!name) {
    throw new EquipmentError("Enter a name for this tool or vehicle.");
  }
  return name;
}

export function parseEquipmentKind(value: string | undefined): EquipmentKind {
  if (!isEquipmentKind(value)) {
    throw new EquipmentError("Choose Tool or Vehicle.");
  }
  return value;
}

export function parseAttemptKey(value: string | undefined) {
  const attemptKey = trimField(value, MAX_ATTEMPT_KEY_LENGTH, "Submit key");
  if (!attemptKey || !/^[A-Za-z0-9_-]+$/.test(attemptKey)) {
    throw new EquipmentError("That submit could not be identified. Try again.");
  }
  return attemptKey;
}

export type RecordEquipmentItemInput = {
  kind: string;
  name: string;
  notes?: string;
  serviceOn?: string;
  purchaseExpenseId?: string;
  attemptKey: string;
};

export type RecordEquipmentMaintenanceInput = {
  equipmentId: string;
  occurredOn: string;
  notes: string;
  attemptKey: string;
};

async function loadMatchingPurchaseExpense(
  db: Db,
  access: BusinessAccess,
  kind: EquipmentKind,
  purchaseExpenseId: string | undefined,
) {
  const id = (purchaseExpenseId ?? "").trim();
  if (!id) return null;

  const expense = await db.expense.findFirst({
    where: {
      id,
      businessId: access.businessId,
      ...REPORTED_EXPENSE_WHERE,
    },
    select: {
      id: true,
      businessId: true,
      category: true,
      voidedAt: true,
      equipmentItem: { select: { id: true } },
    },
  });
  if (!expense) {
    throw new EquipmentError("That purchase is not an active expense in this business.");
  }
  access.assertOwned(expense);
  if (expense.category !== EQUIPMENT_PURCHASE_CATEGORIES[kind]) {
    throw new EquipmentError(
      `A ${EQUIPMENT_KIND_LABELS[kind].toLowerCase()} can only reference a ${
        kind === "TOOL" ? "Tools & Equipment" : "Vehicle"
      } expense.`,
    );
  }
  if (expense.equipmentItem) {
    throw new EquipmentError("That expense is already linked to another register item.");
  }
  return expense.id;
}

async function loadOwnedEquipment(db: Db, access: BusinessAccess, equipmentId: string) {
  const item = await db.equipmentItem.findFirst({
    where: { id: equipmentId, businessId: access.businessId },
  });
  if (!item) {
    throw new EquipmentError("That equipment is not in this business.");
  }
  return access.assertOwned(item);
}

export async function recordEquipmentItem(
  db: PrismaClient,
  access: BusinessAccess,
  input: RecordEquipmentItemInput,
) {
  requireEquipmentWrite(access);
  const kind = parseEquipmentKind(input.kind);
  const name = parseEquipmentName(input.name);
  const notes = trimField(input.notes, MAX_EQUIPMENT_NOTES_LENGTH, "Notes");
  const attemptKey = parseAttemptKey(input.attemptKey);
  const timeZone = equipmentTimeZone(access);
  const serviceOn = optionalEquipmentDate(input.serviceOn, timeZone, "service date");
  const createdByMembershipId = equipmentActorMembershipId(access);

  try {
    const existing = await db.equipmentItem.findFirst({
      where: { businessId: access.businessId, attemptKey },
    });
    if (existing) return access.assertOwned(existing);

    const purchaseExpenseId = await loadMatchingPurchaseExpense(
      db,
      access,
      kind,
      input.purchaseExpenseId,
    );
    await equipmentRegisterTestHooks.beforeItemInsert?.({
      businessId: access.businessId,
      attemptKey,
    });
    return await db.equipmentItem.create({
      data: {
        businessId: access.businessId,
        kind,
        name,
        notes,
        serviceOn,
        purchaseExpenseId,
        createdByMembershipId,
        attemptKey,
      },
    });
  } catch (error) {
    if (isDuplicateEquipmentAttemptError(error)) {
      const existing = await db.equipmentItem.findFirst({
        where: { businessId: access.businessId, attemptKey },
      });
      if (existing) return access.assertOwned(existing);
    }
    throwIfEquipmentSchemaMissing(error);
  }
}

export async function recordEquipmentMaintenance(
  db: PrismaClient,
  access: BusinessAccess,
  input: RecordEquipmentMaintenanceInput,
) {
  requireEquipmentWrite(access);
  const attemptKey = parseAttemptKey(input.attemptKey);
  const notes = trimField(input.notes, MAX_MAINTENANCE_NOTES_LENGTH, "Notes");
  if (!notes) {
    throw new EquipmentError("Enter what was done.");
  }
  const timeZone = equipmentTimeZone(access);
  const occurredOn = requireEquipmentDate(input.occurredOn, timeZone, "maintenance date");
  const createdByMembershipId = equipmentActorMembershipId(access);

  try {
    const existing = await db.equipmentMaintenanceEntry.findFirst({
      where: { businessId: access.businessId, attemptKey },
    });
    if (existing) return access.assertOwned(existing);

    const equipment = await loadOwnedEquipment(db, access, input.equipmentId);
    return await db.equipmentMaintenanceEntry.create({
      data: {
        businessId: access.businessId,
        equipmentId: equipment.id,
        occurredOn,
        notes,
        createdByMembershipId,
        attemptKey,
      },
    });
  } catch (error) {
    if (isDuplicateEquipmentAttemptError(error)) {
      const existing = await db.equipmentMaintenanceEntry.findFirst({
        where: { businessId: access.businessId, attemptKey },
      });
      if (existing) return access.assertOwned(existing);
    }
    throwIfEquipmentSchemaMissing(error);
  }
}

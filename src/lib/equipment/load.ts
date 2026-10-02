/**
 * Tenant-scoped equipment register loader. Every query is keyed by the
 * authenticated workspace businessId. Lists are capped. Due uses the
 * recorded serviceOn date only.
 */

import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { REPORTED_EXPENSE_WHERE } from "@/lib/expenses";
import { formatISODate } from "@/lib/schedule";
import { canWriteEquipmentRegister, requireEquipmentRead } from "@/lib/equipment/access";
import {
  EQUIPMENT_DUE_MESSAGE,
  EQUIPMENT_FIELD_SCOPED_MESSAGE,
  EQUIPMENT_KIND_LABELS,
  EQUIPMENT_LIMITS_MESSAGE,
  EQUIPMENT_MAINTENANCE_READ_LIMIT,
  EQUIPMENT_OVERFLOW_MESSAGE,
  EQUIPMENT_OWNER_ONLY_MESSAGE,
  EQUIPMENT_PURCHASE_CATEGORIES,
  EQUIPMENT_PURCHASE_CHOICE_LIMIT,
  EQUIPMENT_PURCHASE_MESSAGE,
  EQUIPMENT_READ_LIMIT,
  type EquipmentKind,
} from "@/lib/equipment/constants";
import {
  EquipmentUnavailableError,
  isEquipmentKind,
  missingEquipmentSchema,
} from "@/lib/equipment/ops";
import { equipmentIsDue, equipmentTimeZone } from "@/lib/equipment/dates";
import type {
  EquipmentItemView,
  EquipmentPurchaseChoice,
  EquipmentWorkspace,
} from "@/lib/equipment/types";

function boundRows<T>(rows: readonly T[], limit: number) {
  return {
    overflow: rows.length > limit,
    items: rows.slice(0, limit),
  };
}

function toPurchaseChoice(
  expense: { id: string; description: string; category: string; occurredOn: Date },
  timeZone: string,
): EquipmentPurchaseChoice {
  return {
    id: expense.id,
    description: expense.description,
    category: expense.category,
    occurredOn: formatISODate(expense.occurredOn, timeZone),
  };
}

export function resolveEquipmentReadLimit(requested?: number): number {
  if (typeof requested === "number" && Number.isInteger(requested) && requested > 0) {
    return Math.min(requested, EQUIPMENT_READ_LIMIT);
  }
  return EQUIPMENT_READ_LIMIT;
}

export async function loadEquipmentRegister(
  db: PrismaClient,
  access: BusinessAccess,
  options?: { now?: Date; limit?: number },
): Promise<EquipmentWorkspace> {
  requireEquipmentRead(access);
  const timeZone = equipmentTimeZone(access);
  const now = options?.now ?? new Date();
  const readLimit = resolveEquipmentReadLimit(options?.limit);
  const empty: EquipmentWorkspace = {
    available: false,
    canWrite: canWriteEquipmentRegister(access.workspace.role),
    timeZone,
    readLimit,
    maintenanceReadLimit: EQUIPMENT_MAINTENANCE_READ_LIMIT,
    purchaseChoiceLimit: EQUIPMENT_PURCHASE_CHOICE_LIMIT,
    items: [],
    dueItems: [],
    overflow: false,
    dueOverflow: false,
    purchaseChoices: [],
    purchaseChoiceOverflow: false,
    limitsMessage: EQUIPMENT_LIMITS_MESSAGE,
    dueMessage: EQUIPMENT_DUE_MESSAGE,
    ownerOnlyMessage: EQUIPMENT_OWNER_ONLY_MESSAGE,
    fieldScopedMessage: EQUIPMENT_FIELD_SCOPED_MESSAGE,
    purchaseMessage: EQUIPMENT_PURCHASE_MESSAGE,
    overflowMessage: EQUIPMENT_OVERFLOW_MESSAGE,
  };

  try {
    const [itemRows, purchaseRows] = await Promise.all([
      db.equipmentItem.findMany({
        where: { businessId: access.businessId },
        orderBy: [{ serviceOn: "asc" }, { name: "asc" }, { createdAt: "asc" }],
        take: readLimit + 1,
        include: {
          purchaseExpense: {
            select: {
              id: true,
              businessId: true,
              description: true,
              category: true,
              occurredOn: true,
            },
          },
          maintenanceEntries: {
            where: { businessId: access.businessId },
            orderBy: [{ occurredOn: "desc" }, { createdAt: "desc" }],
            take: EQUIPMENT_MAINTENANCE_READ_LIMIT + 1,
            select: { id: true, occurredOn: true, notes: true, businessId: true },
          },
        },
      }),
      db.expense.findMany({
        where: {
          businessId: access.businessId,
          ...REPORTED_EXPENSE_WHERE,
          category: { in: Object.values(EQUIPMENT_PURCHASE_CATEGORIES) },
          equipmentItem: null,
        },
        orderBy: [{ occurredOn: "desc" }, { createdAt: "desc" }],
        take: EQUIPMENT_PURCHASE_CHOICE_LIMIT + 1,
        select: { id: true, description: true, category: true, occurredOn: true },
      }),
    ]);

    const boundedItems = boundRows(itemRows, readLimit);
    const items: EquipmentItemView[] = boundedItems.items
      .filter((row) => row.businessId === access.businessId)
      .map((row) => {
        const kind: EquipmentKind = isEquipmentKind(row.kind) ? row.kind : "TOOL";
        const maintenance = boundRows(
          row.maintenanceEntries.filter((entry) => entry.businessId === access.businessId),
          EQUIPMENT_MAINTENANCE_READ_LIMIT,
        );
        const purchase =
          row.purchaseExpense && row.purchaseExpense.businessId === access.businessId
            ? toPurchaseChoice(row.purchaseExpense, timeZone)
            : null;
        return {
          id: row.id,
          kind,
          kindLabel: EQUIPMENT_KIND_LABELS[kind],
          name: row.name,
          notes: row.notes,
          serviceOn: row.serviceOn ? formatISODate(row.serviceOn, timeZone) : null,
          due: equipmentIsDue(row.serviceOn, now, timeZone),
          purchaseExpense: purchase,
          maintenance: maintenance.items.map((entry) => ({
            id: entry.id,
            occurredOn: formatISODate(entry.occurredOn, timeZone),
            notes: entry.notes,
          })),
          maintenanceOverflow: maintenance.overflow,
        };
      });

    const due = items.filter((item) => item.due);
    const purchases = boundRows(purchaseRows, EQUIPMENT_PURCHASE_CHOICE_LIMIT);

    return {
      ...empty,
      available: true,
      items,
      dueItems: due,
      overflow: boundedItems.overflow,
      dueOverflow: boundedItems.overflow && itemRows.slice(readLimit).some((row) =>
        equipmentIsDue(row.serviceOn, now, timeZone),
      ),
      purchaseChoices: purchases.items.map((row) => toPurchaseChoice(row, timeZone)),
      purchaseChoiceOverflow: purchases.overflow,
    };
  } catch (error) {
    if (error instanceof EquipmentUnavailableError || missingEquipmentSchema(error)) {
      return empty;
    }
    throw error;
  }
}

"use server";

/**
 * Equipment register actions. Tenant scope always comes from
 * requireBusinessAccess() (session workspace), never from a client
 * businessId. OWNER records; ADMIN reads through the page only.
 */
import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import {
  EQUIPMENT_ROUTE,
  equipmentErrorMessage,
  recordEquipmentItem,
  recordEquipmentMaintenance,
} from "@/lib/equipment";
import { prisma } from "@/lib/prisma";

export type EquipmentActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateEquipment() {
  revalidatePath(EQUIPMENT_ROUTE);
}

export async function recordEquipmentItemAction(
  _prev: EquipmentActionState,
  formData: FormData,
): Promise<EquipmentActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await recordEquipmentItem(prisma, access, {
      kind: readString(formData, "kind"),
      name: readString(formData, "name"),
      notes: readString(formData, "notes"),
      serviceOn: readString(formData, "serviceOn"),
      purchaseExpenseId: readString(formData, "purchaseExpenseId"),
      attemptKey: readString(formData, "attemptKey"),
    });
    revalidateEquipment();
    return { message: "Item recorded. TBBT did not invent telemetry, depreciation, or a reminder." };
  } catch (error) {
    return { error: equipmentErrorMessage(error, "That item could not be recorded.") };
  }
}

export async function recordEquipmentMaintenanceAction(
  _prev: EquipmentActionState,
  formData: FormData,
): Promise<EquipmentActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await recordEquipmentMaintenance(prisma, access, {
      equipmentId: readString(formData, "equipmentId"),
      occurredOn: readString(formData, "occurredOn"),
      notes: readString(formData, "notes"),
      attemptKey: readString(formData, "attemptKey"),
    });
    revalidateEquipment();
    return { message: "Maintenance recorded. The due list still uses the service date only." };
  } catch (error) {
    return { error: equipmentErrorMessage(error, "That maintenance entry could not be recorded.") };
  }
}

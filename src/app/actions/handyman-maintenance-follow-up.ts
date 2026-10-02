"use server";

import { revalidatePath } from "next/cache";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  HANDYMAN_MAINTENANCE_CANCELLED_SAVED_MESSAGE,
  HANDYMAN_MAINTENANCE_CREATED_MESSAGE,
  HANDYMAN_MAINTENANCE_JOB_REQUIRED_MESSAGE,
  HANDYMAN_MAINTENANCE_UNKNOWN_MESSAGE,
  handymanMaintenanceFollowUpErrorMessage,
} from "@/lib/handyman-maintenance-follow-up";
import {
  cancelHandymanMaintenanceFollowUp,
  createHandymanMaintenanceFollowUp,
} from "@/lib/handyman-maintenance-follow-up-ops";
import { prisma } from "@/lib/prisma";
import { requireOperatingBusinessAccessForForm } from "@/lib/saas-billing/enforce";

export type HandymanMaintenanceFollowUpActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function requireOwnerMaintenanceAccess() {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return operating;
  requireBusinessCapability(operating.access, CAPABILITIES.MANAGE_JOBS);
  return operating;
}

function revalidateMaintenance(jobId: string, customerId?: string | null) {
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/today");
  revalidatePath("/dashboard");
  revalidatePath("/communications");
  if (customerId) revalidatePath(`/customers/${customerId}`);
}

export async function createHandymanMaintenanceFollowUpAction(
  _prev: HandymanMaintenanceFollowUpActionState,
  formData: FormData,
): Promise<HandymanMaintenanceFollowUpActionState> {
  const operating = await requireOwnerMaintenanceAccess();
  if (!operating.ok) return { error: operating.error };
  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: HANDYMAN_MAINTENANCE_JOB_REQUIRED_MESSAGE };

  try {
    const row = await createHandymanMaintenanceFollowUp(prisma, operating.access, {
      jobId,
      task: readString(formData, "task"),
      dueOn: readString(formData, "dueOn"),
    });
    revalidateMaintenance(jobId, row.customerId);
    return { message: HANDYMAN_MAINTENANCE_CREATED_MESSAGE };
  } catch (error) {
    return {
      error: handymanMaintenanceFollowUpErrorMessage(
        error,
        "That maintenance follow-up could not be saved.",
      ),
    };
  }
}

export async function cancelHandymanMaintenanceFollowUpAction(
  _prev: HandymanMaintenanceFollowUpActionState,
  formData: FormData,
): Promise<HandymanMaintenanceFollowUpActionState> {
  const operating = await requireOwnerMaintenanceAccess();
  if (!operating.ok) return { error: operating.error };
  const followUpId = readString(formData, "followUpId");
  if (!followUpId) return { error: HANDYMAN_MAINTENANCE_UNKNOWN_MESSAGE };

  try {
    const row = await cancelHandymanMaintenanceFollowUp(prisma, operating.access, {
      followUpId,
    });
    if (row.jobId) revalidateMaintenance(row.jobId, row.customerId);
    else {
      revalidatePath("/today");
      revalidatePath("/dashboard");
      revalidatePath("/communications");
    }
    return { message: HANDYMAN_MAINTENANCE_CANCELLED_SAVED_MESSAGE };
  } catch (error) {
    return {
      error: handymanMaintenanceFollowUpErrorMessage(
        error,
        "That maintenance follow-up could not be cancelled.",
      ),
    };
  }
}

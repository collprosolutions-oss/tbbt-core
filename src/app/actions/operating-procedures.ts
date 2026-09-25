"use server";

import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import {
  createOperatingProcedure,
  procedureErrorMessage,
  setOperatingProcedureApproval,
  setOperatingProcedureArchived,
} from "@/lib/operating-procedures-ops";
import { prisma } from "@/lib/prisma";

export type ProcedureActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function createOperatingProcedureAction(
  _prev: ProcedureActionState,
  formData: FormData,
): Promise<ProcedureActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const steps = readString(formData, "steps")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((title) => ({ title }));
    await createOperatingProcedure(prisma, access, {
      title: readString(formData, "title"),
      summary: readString(formData, "summary"),
      tradeCode: readString(formData, "tradeCode") || null,
      serviceCatalogItemId: readString(formData, "serviceCatalogItemId") || null,
      jobType: readString(formData, "jobType") || null,
      steps,
    });
    revalidatePath("/knowledge");
    return { message: "Procedure saved. It is not an automated workflow." };
  } catch (error) {
    return { error: procedureErrorMessage(error, "That procedure could not be saved.") };
  }
}

export async function approveOperatingProcedureAction(
  _prev: ProcedureActionState,
  formData: FormData,
): Promise<ProcedureActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await setOperatingProcedureApproval(prisma, access, {
      procedureId: readString(formData, "procedureId"),
      approvalState: readString(formData, "approvalState") || "APPROVED",
    });
    revalidatePath("/knowledge");
    return { message: "Procedure approval updated. Approved procedures can become Knowledge entries." };
  } catch (error) {
    return { error: procedureErrorMessage(error, "That procedure could not be approved.") };
  }
}

export async function archiveOperatingProcedureAction(
  _prev: ProcedureActionState,
  formData: FormData,
): Promise<ProcedureActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await setOperatingProcedureArchived(prisma, access, {
      procedureId: readString(formData, "procedureId"),
      archived: readString(formData, "archived") === "1",
    });
    revalidatePath("/knowledge");
    return { message: "Procedure archive updated." };
  } catch (error) {
    return { error: procedureErrorMessage(error, "That procedure could not be archived.") };
  }
}

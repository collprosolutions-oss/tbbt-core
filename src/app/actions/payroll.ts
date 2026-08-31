"use server";

/**
 * Payroll server actions. Tenant scope always comes from
 * requireBusinessAccess() (session workspace), never from a client
 * businessId. Prepare/review uses MANAGE_PAYROLL (OWNER/ADMIN).
 * Final authorization and external processed recording use
 * AUTHORIZE_PAYROLL (OWNER only).
 */
import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { parsePayPeriodDates } from "@/lib/payroll";
import {
  addPayrollItem,
  authorizePayrollRun,
  cancelPayrollRun,
  changePayrollPeriod,
  createPayrollRun,
  markPayrollProcessedExternally,
  payrollErrorMessage,
  removePayrollItem,
  reopenPayrollRun,
  reviewPayrollRun,
} from "@/lib/payroll-ops";
import { prisma } from "@/lib/prisma";
import { parseScheduleDate } from "@/lib/schedule";

export type PayrollActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidatePayroll() {
  revalidatePath("/payroll");
  revalidatePath("/time-cards");
}

function readPeriod(formData: FormData) {
  const startRaw = readString(formData, "payPeriodStart");
  const endRaw = readString(formData, "payPeriodEnd");
  const parsed = parsePayPeriodDates(startRaw, endRaw);
  if ("error" in parsed) {
    return parsed;
  }
  return parsed;
}

export async function createPayrollRunAction(
  _prev: PayrollActionState,
  formData: FormData,
): Promise<PayrollActionState> {
  try {
    const access = await requireBusinessAccess();
    const period = readPeriod(formData);
    if ("error" in period) return { error: period.error };
    await createPayrollRun(prisma, access, {
      payPeriodStart: period.start,
      payPeriodEnd: period.end,
      notes: readString(formData, "notes") || undefined,
    });
    revalidatePayroll();
    return { message: "Payroll run created from approved time cards." };
  } catch (error) {
    return { error: payrollErrorMessage(error, "Could not create that payroll run.") };
  }
}

export async function changePayrollPeriodAction(
  _prev: PayrollActionState,
  formData: FormData,
): Promise<PayrollActionState> {
  try {
    const access = await requireBusinessAccess();
    const payrollRunId = readString(formData, "payrollRunId");
    if (!payrollRunId) return { error: "Choose a payroll run." };
    const period = readPeriod(formData);
    if ("error" in period) return { error: period.error };
    await changePayrollPeriod(prisma, access, {
      payrollRunId,
      payPeriodStart: period.start,
      payPeriodEnd: period.end,
    });
    revalidatePayroll();
    return { message: "Pay period updated. Review the assembled weeks again." };
  } catch (error) {
    return { error: payrollErrorMessage(error, "Could not change that pay period.") };
  }
}

export async function addPayrollItemAction(
  _prev: PayrollActionState,
  formData: FormData,
): Promise<PayrollActionState> {
  try {
    const access = await requireBusinessAccess();
    const payrollRunId = readString(formData, "payrollRunId");
    const timesheetWeekId = readString(formData, "timesheetWeekId");
    if (!payrollRunId || !timesheetWeekId) {
      return { error: "Choose an approved timesheet to add." };
    }
    await addPayrollItem(prisma, access, { payrollRunId, timesheetWeekId });
    revalidatePayroll();
    return { message: "Approved week added to this payroll run." };
  } catch (error) {
    return { error: payrollErrorMessage(error, "Could not add that worker week.") };
  }
}

export async function removePayrollItemAction(
  _prev: PayrollActionState,
  formData: FormData,
): Promise<PayrollActionState> {
  try {
    const access = await requireBusinessAccess();
    const payrollRunItemId = readString(formData, "payrollRunItemId");
    if (!payrollRunItemId) return { error: "Choose a worker week to remove." };
    await removePayrollItem(prisma, access, { payrollRunItemId });
    revalidatePayroll();
    return { message: "Worker week removed from this draft payroll run." };
  } catch (error) {
    return { error: payrollErrorMessage(error, "Could not remove that worker week.") };
  }
}

export async function reviewPayrollRunAction(
  _prev: PayrollActionState,
  formData: FormData,
): Promise<PayrollActionState> {
  try {
    const access = await requireBusinessAccess();
    const payrollRunId = readString(formData, "payrollRunId");
    if (!payrollRunId) return { error: "Choose a payroll run." };
    await reviewPayrollRun(prisma, access, { payrollRunId });
    revalidatePayroll();
    return { message: "Payroll run marked reviewed." };
  } catch (error) {
    return { error: payrollErrorMessage(error, "Could not mark that payroll run reviewed.") };
  }
}

export async function authorizePayrollRunAction(
  _prev: PayrollActionState,
  formData: FormData,
): Promise<PayrollActionState> {
  try {
    const access = await requireBusinessAccess();
    const payrollRunId = readString(formData, "payrollRunId");
    const confirmed = readString(formData, "confirmAuthorize") === "yes";
    if (!payrollRunId) return { error: "Choose a payroll run." };
    await authorizePayrollRun(prisma, access, { payrollRunId, confirmed });
    revalidatePayroll();
    return { message: "Payroll authorized. No funds were moved." };
  } catch (error) {
    return { error: payrollErrorMessage(error, "Could not authorize that payroll run.") };
  }
}

export async function reopenPayrollRunAction(
  _prev: PayrollActionState,
  formData: FormData,
): Promise<PayrollActionState> {
  try {
    const access = await requireBusinessAccess();
    const payrollRunId = readString(formData, "payrollRunId");
    const reason = readString(formData, "reason");
    if (!payrollRunId) return { error: "Choose a payroll run." };
    await reopenPayrollRun(prisma, access, { payrollRunId, reason });
    revalidatePayroll();
    return { message: "Payroll run reopened for correction. Prior authorization history is kept." };
  } catch (error) {
    return { error: payrollErrorMessage(error, "Could not reopen that payroll run.") };
  }
}

export async function cancelPayrollRunAction(
  _prev: PayrollActionState,
  formData: FormData,
): Promise<PayrollActionState> {
  try {
    const access = await requireBusinessAccess();
    const payrollRunId = readString(formData, "payrollRunId");
    const reason = readString(formData, "reason");
    if (!payrollRunId) return { error: "Choose a payroll run." };
    await cancelPayrollRun(prisma, access, { payrollRunId, reason });
    revalidatePayroll();
    return { message: "Payroll run cancelled. The record is kept." };
  } catch (error) {
    return { error: payrollErrorMessage(error, "Could not cancel that payroll run.") };
  }
}

export async function markPayrollProcessedAction(
  _prev: PayrollActionState,
  formData: FormData,
): Promise<PayrollActionState> {
  try {
    const access = await requireBusinessAccess();
    const payrollRunId = readString(formData, "payrollRunId");
    const confirmed = readString(formData, "confirmProcessed") === "yes";
    const providerReference = readString(formData, "providerReference");
    const processedAtRaw = readString(formData, "processedAt");
    if (!payrollRunId) return { error: "Choose a payroll run." };
    await markPayrollProcessedExternally(prisma, access, {
      payrollRunId,
      confirmed,
      providerReference,
      processedAt: processedAtRaw ? parseScheduleDate(processedAtRaw) : undefined,
    });
    revalidatePayroll();
    return { message: "Recorded as processed externally. TBBT did not move funds." };
  } catch (error) {
    return { error: payrollErrorMessage(error, "Could not record that external payroll result.") };
  }
}

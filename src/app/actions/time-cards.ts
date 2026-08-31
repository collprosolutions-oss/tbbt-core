"use server";

/**
 * Time Cards server actions. Tenant scope always comes from
 * requireBusinessAccess() (session workspace), never from a client
 * businessId. OWNER/ADMIN management mutations require
 * CAPABILITIES.MANAGE_TIME_CARDS. MEMBER may only clock themselves
 * (and only onto an assigned Job for JOB time) -- that gate lives in
 * src/lib/time-card-ops.ts.
 */
import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { parseScheduleDate } from "@/lib/schedule";
import { parseDateTimeInput } from "@/lib/time-cards";
import {
  approveTimesheetWeek,
  clockInTime,
  clockOutTime,
  correctTimeEntry,
  createManualTimeEntry,
  reopenTimesheetWeek,
  requestTimeCorrection,
  timeCardErrorMessage,
  updateMembershipWage,
} from "@/lib/time-card-ops";

export type TimeCardActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateTimeCards(jobId?: string | null) {
  revalidatePath("/time-cards");
  revalidatePath("/payroll");
  revalidatePath("/field");
  if (jobId) {
    revalidatePath(`/field/jobs/${jobId}`);
  }
}

export async function clockInAction(
  _prev: TimeCardActionState,
  formData: FormData,
): Promise<TimeCardActionState> {
  try {
    const access = await requireBusinessAccess();
    const membershipId = readString(formData, "membershipId") || access.workspace.membership.id;
    const activityType = readString(formData, "activityType");
    const jobId = readString(formData, "jobId") || null;
    const note = readString(formData, "note") || null;
    await clockInTime(prisma, access, { membershipId, activityType, jobId, note });
    revalidateTimeCards(jobId);
    return { message: "Clocked in." };
  } catch (error) {
    return { error: timeCardErrorMessage(error, "Could not clock in.") };
  }
}

export async function clockOutAction(
  _prev: TimeCardActionState,
  formData: FormData,
): Promise<TimeCardActionState> {
  try {
    const access = await requireBusinessAccess();
    const membershipId = readString(formData, "membershipId") || access.workspace.membership.id;
    const note = readString(formData, "note") || null;
    const result = await clockOutTime(prisma, access, { membershipId, note });
    revalidateTimeCards(result.jobId);
    return { message: "Clocked out." };
  } catch (error) {
    return { error: timeCardErrorMessage(error, "Could not clock out.") };
  }
}

export async function createManualTimeEntryAction(
  _prev: TimeCardActionState,
  formData: FormData,
): Promise<TimeCardActionState> {
  try {
    const access = await requireBusinessAccess();
    const membershipId = readString(formData, "membershipId");
    const activityType = readString(formData, "activityType");
    const jobId = readString(formData, "jobId") || null;
    const note = readString(formData, "note") || null;
    const startedAt = parseDateTimeInput(readString(formData, "startDate"), readString(formData, "startTime"));
    const endedAt = parseDateTimeInput(readString(formData, "endDate"), readString(formData, "endTime"));
    if (!membershipId) return { error: "Choose a worker." };
    if (!startedAt || !endedAt) return { error: "Enter a valid start and end time." };
    await createManualTimeEntry(prisma, access, {
      membershipId,
      activityType,
      jobId,
      startedAt,
      endedAt,
      note,
      needsReview: readString(formData, "needsReview") === "1",
    });
    revalidateTimeCards(jobId);
    return { message: "Time entry saved." };
  } catch (error) {
    return { error: timeCardErrorMessage(error, "Could not save that time entry.") };
  }
}

export async function correctTimeEntryAction(
  _prev: TimeCardActionState,
  formData: FormData,
): Promise<TimeCardActionState> {
  try {
    const access = await requireBusinessAccess();
    const timeEntryId = readString(formData, "timeEntryId");
    const reason = readString(formData, "reason");
    const startDate = readString(formData, "startDate");
    const startTime = readString(formData, "startTime");
    const endDate = readString(formData, "endDate");
    const endTime = readString(formData, "endTime");
    const activityType = readString(formData, "activityType") || undefined;
    const jobRaw = readString(formData, "jobId");
    const note = readString(formData, "note");
    if (!timeEntryId) return { error: "That time entry could not be found." };
    let startedAt: Date | undefined;
    if (startDate || startTime) {
      const parsedStart = parseDateTimeInput(startDate, startTime);
      if (!parsedStart) return { error: "Enter a valid start time." };
      startedAt = parsedStart;
    }
    let endedAt: Date | undefined;
    if (endDate || endTime) {
      const parsedEnd = parseDateTimeInput(endDate, endTime);
      if (!parsedEnd) return { error: "Enter a valid end time." };
      endedAt = parsedEnd;
    }
    await correctTimeEntry(prisma, access, {
      timeEntryId,
      reason,
      startedAt,
      endedAt,
      activityType,
      jobId: jobRaw === "" ? undefined : jobRaw,
      note: note === "" ? undefined : note,
    });
    revalidateTimeCards();
    return { message: "Correction saved." };
  } catch (error) {
    return { error: timeCardErrorMessage(error, "Could not correct that entry.") };
  }
}

export async function requestTimeCorrectionAction(
  _prev: TimeCardActionState,
  formData: FormData,
): Promise<TimeCardActionState> {
  try {
    const access = await requireBusinessAccess();
    const timeEntryId = readString(formData, "timeEntryId");
    const reason = readString(formData, "reason");
    if (!timeEntryId) return { error: "That time entry could not be found." };
    await requestTimeCorrection(prisma, access, { timeEntryId, reason });
    revalidateTimeCards();
    return { message: "Correction requested." };
  } catch (error) {
    return { error: timeCardErrorMessage(error, "Could not request that correction.") };
  }
}

export async function updateMembershipWageAction(
  _prev: TimeCardActionState,
  formData: FormData,
): Promise<TimeCardActionState> {
  try {
    const access = await requireBusinessAccess();
    const membershipId = readString(formData, "membershipId");
    const hourlyWage = readString(formData, "hourlyWage");
    if (!membershipId) return { error: "Choose a worker." };
    await updateMembershipWage(prisma, access, { membershipId, hourlyWage });
    revalidateTimeCards();
    return { message: "Wage updated." };
  } catch (error) {
    return { error: timeCardErrorMessage(error, "Could not update that wage.") };
  }
}

export async function approveTimesheetWeekAction(
  _prev: TimeCardActionState,
  formData: FormData,
): Promise<TimeCardActionState> {
  try {
    const access = await requireBusinessAccess();
    const membershipId = readString(formData, "membershipId");
    const weekStartedAtRaw = readString(formData, "weekStartedAt");
    if (!membershipId || !weekStartedAtRaw) {
      return { error: "Choose a worker and week." };
    }
    const weekStartedAt = parseScheduleDate(weekStartedAtRaw);
    await approveTimesheetWeek(prisma, access, { membershipId, weekStartedAt });
    revalidateTimeCards();
    return { message: "Week approved — payroll ready." };
  } catch (error) {
    return { error: timeCardErrorMessage(error, "Could not approve that week.") };
  }
}

export async function reopenTimesheetWeekAction(
  _prev: TimeCardActionState,
  formData: FormData,
): Promise<TimeCardActionState> {
  try {
    const access = await requireBusinessAccess();
    const membershipId = readString(formData, "membershipId");
    const weekStartedAtRaw = readString(formData, "weekStartedAt");
    const reason = readString(formData, "reason");
    if (!membershipId || !weekStartedAtRaw) {
      return { error: "Choose a worker and week." };
    }
    const weekStartedAt = parseScheduleDate(weekStartedAtRaw);
    await reopenTimesheetWeek(prisma, access, { membershipId, weekStartedAt, reason });
    revalidateTimeCards();
    return { message: "Week reopened." };
  } catch (error) {
    return { error: timeCardErrorMessage(error, "Could not reopen that week.") };
  }
}

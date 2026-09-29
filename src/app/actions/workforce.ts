"use server";

import { revalidatePath } from "next/cache";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { parseUnavailableDate } from "@/lib/availability";
import {
  AVAILABILITY_REQUEST_DECISIONS,
  OUTREACH_TASK_KINDS,
  parseBoundedInt,
  parseExpectedUpdatedAt,
  parseOptionalBoundedInt,
  parseSkillList,
  type AvailabilityRequestDecision,
  type OutreachTaskKind,
} from "@/lib/workforce";
import {
  availabilityRequestErrorMessage,
  decideMemberAvailabilityExceptionRequestOp,
  requestMemberAvailabilityExceptionOp,
} from "@/lib/workforce-availability-request-ops";
import {
  createWorkforceOutreachTaskOp,
  setMemberAvailabilityExceptionOp,
  setMemberWeeklyAvailabilityOp,
  markFillInBenchUsedOp,
  updateWorkforceProfileOp,
  upsertFillInBenchWorkerOp,
  WorkforceError,
} from "@/lib/workforce-ops";
import {
  reviewStaffingRecommendationOp,
  staffingReviewErrorMessage,
} from "@/lib/workforce-staffing-ops";
import { STAFFING_REVIEW_DECISIONS, type StaffingReviewDecision } from "@/lib/workforce-staffing";
import { prisma } from "@/lib/prisma";

export type WorkforceActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateWorkforce() {
  revalidatePath("/team");
  revalidatePath("/team/bench");
  revalidatePath("/jobs");
  revalidatePath("/field");
  revalidatePath("/business-health");
}

function timeToMinutes(value: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export async function updateWorkforceProfile(
  _prev: WorkforceActionState,
  formData: FormData,
): Promise<WorkforceActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);

  const membershipId = readString(formData, "membershipId");
  if (!membershipId) return { error: "That team member could not be found." };

  const skills = formData
    .getAll("skillKey")
    .filter((value): value is string => typeof value === "string")
    .map((skillKey) => ({
      skillKey,
      proficiency: readString(formData, `proficiency-${skillKey}`),
    }));

  try {
    await updateWorkforceProfileOp(prisma, access, {
      membershipId,
      schedulingActive: readString(formData, "schedulingActive") !== "0",
      progression: readString(formData, "progression"),
      maxDailyJobMinutes: parseOptionalBoundedInt(readString(formData, "maxDailyJobMinutes"), 30, 24 * 60),
      workforceNotes: readString(formData, "workforceNotes"),
      skills,
    });
  } catch (error) {
    if (error instanceof WorkforceError) return { error: error.message };
    throw error;
  }

  revalidateWorkforce();
  return { message: "Workforce profile saved. This does not change any job assignment." };
}

export async function saveMemberWeeklyAvailability(
  _prev: WorkforceActionState,
  formData: FormData,
): Promise<WorkforceActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);

  const membershipId = readString(formData, "membershipId");
  if (!membershipId) return { error: "That team member could not be found." };

  const inherit = readString(formData, "inheritBusinessHours") === "1";
  const slots = inherit
    ? []
    : [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => {
        const enabled = readString(formData, `weekday-${weekday}`) === "1";
        if (!enabled) return [];
        const startMinutes = timeToMinutes(readString(formData, `start-${weekday}`));
        const endMinutes = timeToMinutes(readString(formData, `end-${weekday}`));
        if (startMinutes == null || endMinutes == null) return [];
        return [{ weekday, startMinutes, endMinutes }];
      });

  try {
    await setMemberWeeklyAvailabilityOp(prisma, access, { membershipId, slots });
  } catch (error) {
    if (error instanceof WorkforceError) return { error: error.message };
    throw error;
  }
  revalidateWorkforce();
  return {
    message: inherit || slots.length === 0
      ? "Weekly hours cleared. This member inherits business hours when schedulable."
      : "Weekly availability saved.",
  };
}

export async function saveMemberAvailabilityException(
  _prev: WorkforceActionState,
  formData: FormData,
): Promise<WorkforceActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);

  const membershipId = readString(formData, "membershipId");
  const date = parseUnavailableDate(readString(formData, "date"));
  if (!membershipId || !date) {
    return { error: "Choose a team member and a valid date." };
  }

  try {
    await setMemberAvailabilityExceptionOp(prisma, access, {
      membershipId,
      date,
      kind: readString(formData, "kind") === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE",
    });
  } catch (error) {
    if (error instanceof WorkforceError) return { error: error.message };
    throw error;
  }
  revalidateWorkforce();
  return { message: "Date exception saved. It overrides weekly hours for that day only." };
}

export async function saveFillInBenchWorker(
  _prev: WorkforceActionState,
  formData: FormData,
): Promise<WorkforceActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);

  try {
    await upsertFillInBenchWorkerOp(prisma, access, {
      id: readString(formData, "id") || undefined,
      displayName: readString(formData, "displayName"),
      contactPreference: readString(formData, "contactPreference") || "PHONE",
      contactValue: readString(formData, "contactValue"),
      skills: formData
        .getAll("benchSkill")
        .filter((value): value is string => typeof value === "string"),
      availabilityNotes: readString(formData, "availabilityNotes"),
      workerType: readString(formData, "workerType") || "BACKUP",
      locationNotes: readString(formData, "locationNotes"),
      approved: readString(formData, "approved") === "1",
      active: readString(formData, "active") === "1",
      notes: readString(formData, "notes"),
      membershipId: readString(formData, "membershipId") || null,
    });
  } catch (error) {
    if (error instanceof WorkforceError) return { error: error.message };
    throw error;
  }

  revalidateWorkforce();
  return { message: "Internal Fill-In Bench worker saved. This profile is not public." };
}

export async function markFillInBenchUsed(
  _prev: WorkforceActionState,
  formData: FormData,
): Promise<WorkforceActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);
  const id = readString(formData, "benchWorkerId");
  if (!id) return { error: "That bench worker could not be found." };
  try {
    await markFillInBenchUsedOp(prisma, access, id);
  } catch (error) {
    if (error instanceof WorkforceError) return { error: error.message };
    throw error;
  }
  revalidateWorkforce();
  return { message: "Marked as last used. No message was sent." };
}

export async function createWorkforceOutreachTask(
  _prev: WorkforceActionState,
  formData: FormData,
): Promise<WorkforceActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.SCHEDULING);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);

  const kindRaw = readString(formData, "kind");
  const kind = (OUTREACH_TASK_KINDS as readonly string[]).includes(kindRaw)
    ? (kindRaw as OutreachTaskKind)
    : "STAFFING_SHORTAGE";

  try {
    const task = await createWorkforceOutreachTaskOp(prisma, access, {
      kind,
      jobId: readString(formData, "jobId") || null,
      benchWorkerId: readString(formData, "benchWorkerId") || null,
      missingSkills: parseSkillList(readString(formData, "missingSkills")),
      missingMinutes: parseBoundedInt(readString(formData, "missingMinutes"), 0, 0, 24 * 60),
      explanation: readString(formData, "explanation") || "Staffing outreach task.",
      approve: readString(formData, "approve") === "1",
      attemptId: readString(formData, "attemptId"),
    });
    revalidateWorkforce();
    return {
      message:
        task.status === "APPROVED"
          ? "Owner-approved outreach task recorded. No worker was contacted."
          : "Outreach task recorded as a draft. Owner approval is required before anyone is contacted. No worker was contacted.",
    };
  } catch (error) {
    if (error instanceof WorkforceError) return { error: error.message };
    throw error;
  }
}

export async function requestAvailabilityException(
  _prev: WorkforceActionState,
  formData: FormData,
): Promise<WorkforceActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  const membershipId = readString(formData, "membershipId") || access.workspace.membership.id;
  const date = parseUnavailableDate(readString(formData, "date"));
  if (!date) return { error: "Choose a valid date." };

  const kind = readString(formData, "kind") === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE";
  const startMinutes = timeToMinutes(readString(formData, "start"));
  const endMinutes = timeToMinutes(readString(formData, "end"));

  try {
    await requestMemberAvailabilityExceptionOp(prisma, access, {
      membershipId,
      date,
      kind,
      startMinutes,
      endMinutes,
      note: readString(formData, "note"),
    });
  } catch (error) {
    return { error: availabilityRequestErrorMessage(error, "That request could not be submitted.") };
  }

  revalidateWorkforce();
  return {
    message:
      "Request sent to the owner. Recorded availability does not change until they accept. Existing jobs were not cancelled, reassigned, or messaged.",
  };
}

export async function decideAvailabilityExceptionRequest(
  _prev: WorkforceActionState,
  formData: FormData,
): Promise<WorkforceActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;

  const requestId = readString(formData, "requestId");
  const expectedUpdatedAt = parseExpectedUpdatedAt(readString(formData, "expectedUpdatedAt"));
  const decisionRaw = readString(formData, "decision");
  const decision = (AVAILABILITY_REQUEST_DECISIONS as readonly string[]).includes(decisionRaw)
    ? (decisionRaw as AvailabilityRequestDecision)
    : null;
  if (!requestId || !expectedUpdatedAt || !decision) {
    return { error: "Choose a pending request to accept or decline." };
  }

  try {
    const result = await decideMemberAvailabilityExceptionRequestOp(prisma, access, {
      requestId,
      decision,
      expectedUpdatedAt,
      replaceExisting: readString(formData, "replaceExisting") === "1",
    });
    revalidateWorkforce();
    return {
      message:
        result.decision === "ACCEPT"
          ? "Accepted. Recorded availability now includes that date. Existing jobs were not cancelled, reassigned, or messaged."
          : "Declined. Recorded availability is unchanged. Existing jobs were not cancelled, reassigned, or messaged.",
    };
  } catch (error) {
    return { error: availabilityRequestErrorMessage(error, "That request could not be decided.") };
  }
}

export async function reviewStaffingRecommendation(
  _prev: WorkforceActionState,
  formData: FormData,
): Promise<WorkforceActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;

  const decisionRaw = readString(formData, "decision");
  const decision = (STAFFING_REVIEW_DECISIONS as readonly string[]).includes(decisionRaw)
    ? (decisionRaw as StaffingReviewDecision)
    : null;
  if (!decision) return { error: "Choose accept or dismiss." };

  try {
    const result = await reviewStaffingRecommendationOp(prisma, access, {
      recommendationKey: readString(formData, "recommendationKey"),
      evidenceKey: readString(formData, "evidenceKey"),
      decision,
    });
    revalidateWorkforce();
    return {
      message:
        result.decision === "ACCEPT"
          ? "Owner accepted this staffing recommendation as an action-plan item. No worker was assigned, contacted, hired, or rescheduled."
          : "Staffing recommendation dismissed. It will stay in history until facts change. No worker was assigned or contacted.",
    };
  } catch (error) {
    if (error instanceof WorkforceError) return { error: error.message };
    return { error: staffingReviewErrorMessage(error, "That staffing recommendation could not be reviewed.") };
  }
}

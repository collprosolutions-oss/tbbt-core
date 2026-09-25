/**
 * Workforce mutations. Tenant-scoped from BusinessAccess.scope.
 * Never assign workers or rewrite schedules from recommendation helpers.
 * Schema ownership is the Prisma migration — these paths never run DDL.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, ForbiddenError, requireBusinessCapability } from "@/lib/authorization";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireProductCapability } from "@/lib/product-entitlements";
import {
  parseSkillList,
  requireBenchContactPreference,
  requireDayMinutesRange,
  requireExceptionKind,
  requireIsoDate,
  requireWeekday,
  requireWorkforceProgression,
  requireOutreachAttemptId,
  requireWorkforceSkillKey,
  serializeSkillList,
  WorkforceValidationError,
  type OutreachTaskKind,
} from "@/lib/workforce";
import { loadJobAssignmentSuggestions } from "@/lib/workforce-data";
import { staffingShortage } from "@/lib/workforce-matching";

export class WorkforceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkforceError";
  }
}

function asWorkforceError(error: unknown): never {
  if (error instanceof WorkforceValidationError || error instanceof WorkforceError) {
    throw new WorkforceError(error.message);
  }
  throw error;
}

function readOwnedMembership(access: BusinessAccess, membershipId: string) {
  return {
    id: membershipId,
    businessId: access.businessId,
  };
}

export async function updateWorkforceProfileOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    membershipId: string;
    schedulingActive: boolean;
    progression: string;
    maxDailyJobMinutes: number | null;
    preferredJobTypes?: string[];
    allowedJobTypes?: string[];
    workforceNotes?: string;
    skills: Array<{ skillKey: string; proficiency: string }>;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);

  const membership = await db.membership.findFirst({
    where: { id: input.membershipId, businessId: access.businessId },
    select: {
      id: true,
      businessId: true,
      active: true,
      preferredJobTypes: true,
      allowedJobTypes: true,
      workforceNotes: true,
    },
  });
  if (!membership) {
    throw new ForbiddenError();
  }
  access.assertOwned(membership);

  try {
    requireWorkforceProgression(input.progression);
    if (input.maxDailyJobMinutes != null && (!Number.isInteger(input.maxDailyJobMinutes) || input.maxDailyJobMinutes < 30 || input.maxDailyJobMinutes > 24 * 60)) {
      throw new WorkforceError("Max daily minutes must be between 30 and 1440.");
    }
    const skills = input.skills.map((skill) => ({
      skillKey: requireWorkforceSkillKey(skill.skillKey),
      proficiency: requireWorkforceProgression(skill.proficiency),
    }));

    await db.$transaction(async (tx) => {
      await tx.membership.update({
        where: { id: membership.id },
        data: {
          schedulingActive: membership.active ? input.schedulingActive : false,
          progression: input.progression,
          maxDailyJobMinutes: input.maxDailyJobMinutes,
          preferredJobTypes:
            input.preferredJobTypes == null
              ? membership.preferredJobTypes
              : serializeSkillList(input.preferredJobTypes),
          allowedJobTypes:
            input.allowedJobTypes == null
              ? membership.allowedJobTypes
              : serializeSkillList(input.allowedJobTypes),
          workforceNotes:
            input.workforceNotes == null ? membership.workforceNotes : input.workforceNotes.slice(0, 500),
        },
      });
      await tx.membershipSkill.deleteMany({
        where: { membershipId: membership.id, businessId: access.businessId },
      });
      if (skills.length > 0) {
        await tx.membershipSkill.createMany({
          data: skills.map((skill) => ({
            businessId: access.businessId,
            membershipId: membership.id,
            skillKey: skill.skillKey,
            proficiency: skill.proficiency,
          })),
        });
      }
    });
  } catch (error) {
    asWorkforceError(error);
  }

  return { membershipId: membership.id };
}

export async function setMemberWeeklyAvailabilityOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    membershipId: string;
    slots: Array<{ weekday: number; startMinutes: number; endMinutes: number }>;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  const membership = await db.membership.findFirst({
    where: readOwnedMembership(access, input.membershipId),
    select: { id: true, businessId: true },
  });
  if (!membership) throw new ForbiddenError();
  access.assertOwned(membership);

  try {
    const slots = input.slots.map((slot) => {
      const weekday = requireWeekday(slot.weekday);
      const range = requireDayMinutesRange(slot.startMinutes, slot.endMinutes);
      return { weekday, ...range };
    });
    await db.$transaction(async (tx) => {
      await tx.membershipWeeklyAvailability.deleteMany({
        where: { membershipId: membership.id, businessId: access.businessId },
      });
      if (slots.length > 0) {
        await tx.membershipWeeklyAvailability.createMany({
          data: slots.map((slot) => ({
            businessId: access.businessId,
            membershipId: membership.id,
            weekday: slot.weekday,
            startMinutes: slot.startMinutes,
            endMinutes: slot.endMinutes,
          })),
        });
      }
    });
  } catch (error) {
    asWorkforceError(error);
  }
}

export async function setMemberAvailabilityExceptionOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    membershipId: string;
    date: string;
    kind: "AVAILABLE" | "UNAVAILABLE";
    startMinutes?: number | null;
    endMinutes?: number | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  const membership = await db.membership.findFirst({
    where: readOwnedMembership(access, input.membershipId),
    select: { id: true, businessId: true },
  });
  if (!membership) throw new ForbiddenError();
  access.assertOwned(membership);

  try {
    const date = requireIsoDate(input.date);
    const kind = requireExceptionKind(input.kind);
    if (kind === "AVAILABLE" && input.startMinutes != null && input.endMinutes != null) {
      requireDayMinutesRange(input.startMinutes, input.endMinutes);
    }
    await db.membershipAvailabilityException.upsert({
      where: { membershipId_date: { membershipId: membership.id, date } },
      create: {
        businessId: access.businessId,
        membershipId: membership.id,
        date,
        kind,
        startMinutes: input.startMinutes ?? null,
        endMinutes: input.endMinutes ?? null,
      },
      update: {
        kind,
        startMinutes: input.startMinutes ?? null,
        endMinutes: input.endMinutes ?? null,
      },
    });
  } catch (error) {
    asWorkforceError(error);
  }
}

export async function upsertFillInBenchWorkerOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    id?: string;
    displayName: string;
    contactPreference: string;
    contactValue: string;
    skills: string[];
    availabilityNotes: string;
    approved: boolean;
    active: boolean;
    notes: string;
    membershipId?: string | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);

  if (!input.displayName.trim()) {
    throw new WorkforceError("Enter a name for this bench worker.");
  }
  let contactPreference;
  try {
    contactPreference = requireBenchContactPreference(input.contactPreference);
    input.skills.forEach((skill) => requireWorkforceSkillKey(skill));
  } catch (error) {
    asWorkforceError(error);
  }
  if (input.membershipId) {
    const linked = await db.membership.findFirst({
      where: { id: input.membershipId, businessId: access.businessId },
      select: { id: true, businessId: true },
    });
    if (!linked) throw new ForbiddenError();
    access.assertOwned(linked);
  }

  const data = {
    displayName: input.displayName.trim().slice(0, 80),
    contactPreference,
    contactValue: input.contactValue.trim().slice(0, 120),
    skills: serializeSkillList(input.skills),
    availabilityNotes: input.availabilityNotes.slice(0, 240),
    approved: input.approved,
    active: input.active,
    notes: input.notes.slice(0, 500),
    membershipId: input.membershipId ?? null,
  };

  if (input.id) {
    const existing = await db.fillInBenchWorker.findFirst({
      where: { id: input.id, businessId: access.businessId },
    });
    if (!existing) throw new ForbiddenError();
    access.assertOwned(existing);
    return db.fillInBenchWorker.update({
      where: { id: existing.id },
      data,
    });
  }

  return db.fillInBenchWorker.create({
    data: {
      businessId: access.businessId,
      ...data,
    },
  });
}

export async function markFillInBenchUsedOp(
  db: PrismaClient,
  access: BusinessAccess,
  benchWorkerId: string,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  const existing = await db.fillInBenchWorker.findFirst({
    where: { id: benchWorkerId, businessId: access.businessId },
  });
  if (!existing) throw new ForbiddenError();
  access.assertOwned(existing);
  return db.fillInBenchWorker.update({
    where: { id: existing.id },
    data: { lastUsedAt: new Date() },
  });
}

export async function createWorkforceOutreachTaskOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    kind: OutreachTaskKind;
    jobId?: string | null;
    benchWorkerId?: string | null;
    missingSkills: string[];
    missingMinutes?: number | null;
    explanation: string;
    approve: boolean;
    attemptId: string;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.SCHEDULING);
  if (input.jobId) {
    await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.JOBS_TASKS);
  }

  let missingSkills = input.missingSkills;
  let explanation = input.explanation;
  let missingMinutes = input.missingMinutes ?? null;

  if (input.jobId) {
    const job = await db.job.findFirst({
      where: { id: input.jobId, businessId: access.businessId },
      select: {
        id: true,
        businessId: true,
        scheduledAt: true,
        scheduledDurationMinutes: true,
        pickupDurationMinutes: true,
        requiredSkills: true,
        requiredProgression: true,
      },
    });
    if (!job) throw new ForbiddenError();
    access.assertOwned(job);
    const recommendations = await loadJobAssignmentSuggestions(db, access.businessId, job);
    const shortage = staffingShortage({
      requiredSkills: parseSkillList(job.requiredSkills),
      durationMinutes: job.scheduledDurationMinutes,
      pickupMinutes: job.pickupDurationMinutes ?? 0,
      start: job.scheduledAt,
      recommendations,
    });
    missingSkills = shortage.missingSkills;
    explanation = shortage.explanation;
    missingMinutes = shortage.missingMinutes;
  }

  if (input.benchWorkerId) {
    const bench = await db.fillInBenchWorker.findFirst({
      where: { id: input.benchWorkerId, businessId: access.businessId },
      select: { id: true, businessId: true, approved: true, active: true },
    });
    if (!bench) throw new ForbiddenError();
    access.assertOwned(bench);
    if (input.approve && access.workspace.role === "OWNER" && (!bench.approved || !bench.active)) {
      throw new WorkforceError("Approved outreach can only attach an active, approved bench worker.");
    }
  }

  const ownerApproved = input.approve && access.workspace.role === "OWNER";
  let idempotencyKey: string;
  try {
    idempotencyKey = requireOutreachAttemptId(input.attemptId);
  } catch (error) {
    asWorkforceError(error);
  }

  const existing = await db.workforceOutreachTask.findFirst({
    where: { businessId: access.businessId, idempotencyKey },
  });
  if (existing) return existing;

  try {
    return await db.workforceOutreachTask.create({
      data: {
        businessId: access.businessId,
        status: ownerApproved ? "APPROVED" : "DRAFT",
        kind: input.kind,
        jobId: input.jobId ?? null,
        benchWorkerId: input.benchWorkerId ?? null,
        missingSkills: serializeSkillList(missingSkills),
        missingMinutes,
        explanation: explanation.slice(0, 500),
        createdByMembershipId: access.workspace.membership.id,
        approvedByMembershipId: ownerApproved ? access.workspace.membership.id : null,
        idempotencyKey,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await db.workforceOutreachTask.findFirst({
        where: { businessId: access.businessId, idempotencyKey },
      });
      if (winner) return winner;
    }
    throw error;
  }
}

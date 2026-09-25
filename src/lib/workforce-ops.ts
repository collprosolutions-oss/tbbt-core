/**
 * Workforce mutations. Tenant-scoped from BusinessAccess.scope.
 * Never assign workers or rewrite schedules from recommendation helpers.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, ForbiddenError, requireBusinessCapability } from "@/lib/authorization";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireProductCapability } from "@/lib/product-entitlements";
import {
  parseSkillList,
  parseWorkforceProgression,
  serializeSkillList,
  type OutreachTaskKind,
  type WorkforceProgression,
} from "@/lib/workforce";
import { ensureWorkforceSchema } from "@/lib/workforce-data";

export class WorkforceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkforceError";
  }
}

function readOwnedMembership(
  access: BusinessAccess,
  membershipId: string,
) {
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
    progression: WorkforceProgression;
    maxDailyJobMinutes: number | null;
    preferredJobTypes: string[];
    allowedJobTypes: string[];
    workforceNotes: string;
    skills: Array<{ skillKey: string; proficiency: WorkforceProgression }>;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  await ensureWorkforceSchema(db);

  const membership = await db.membership.findFirst({
    where: { id: input.membershipId, businessId: access.businessId },
    select: { id: true, businessId: true },
  });
  if (!membership) {
    throw new ForbiddenError();
  }
  access.assertOwned(membership);

  await db.$transaction(async (tx) => {
    await tx.membership.update({
      where: { id: membership.id },
      data: {
        schedulingActive: input.schedulingActive,
        progression: input.progression,
        maxDailyJobMinutes: input.maxDailyJobMinutes,
        preferredJobTypes: serializeSkillList(input.preferredJobTypes),
        allowedJobTypes: serializeSkillList(input.allowedJobTypes),
        workforceNotes: input.workforceNotes.slice(0, 500),
      },
    });
    await tx.membershipSkill.deleteMany({
      where: { membershipId: membership.id, businessId: access.businessId },
    });
    if (input.skills.length > 0) {
      await tx.membershipSkill.createMany({
        data: input.skills.map((skill) => ({
          businessId: access.businessId,
          membershipId: membership.id,
          skillKey: skill.skillKey,
          proficiency: skill.proficiency,
        })),
      });
    }
  });

  return { membershipId: membership.id };
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
  await ensureWorkforceSchema(db);
  const membership = await db.membership.findFirst({
    where: readOwnedMembership(access, input.membershipId),
    select: { id: true, businessId: true },
  });
  if (!membership) throw new ForbiddenError();
  access.assertOwned(membership);

  await db.membershipAvailabilityException.upsert({
    where: { membershipId_date: { membershipId: membership.id, date: input.date } },
    create: {
      businessId: access.businessId,
      membershipId: membership.id,
      date: input.date,
      kind: input.kind,
      startMinutes: input.startMinutes ?? null,
      endMinutes: input.endMinutes ?? null,
    },
    update: {
      kind: input.kind,
      startMinutes: input.startMinutes ?? null,
      endMinutes: input.endMinutes ?? null,
    },
  });
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
  await ensureWorkforceSchema(db);

  if (!input.displayName.trim()) {
    throw new WorkforceError("Enter a name for this bench worker.");
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
    contactPreference: input.contactPreference,
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
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.SCHEDULING);
  await ensureWorkforceSchema(db);

  if (input.jobId) {
    const job = await db.job.findFirst({
      where: { id: input.jobId, businessId: access.businessId },
      select: { id: true, businessId: true },
    });
    if (!job) throw new ForbiddenError();
    access.assertOwned(job);
  }
  if (input.benchWorkerId) {
    const bench = await db.fillInBenchWorker.findFirst({
      where: { id: input.benchWorkerId, businessId: access.businessId },
      select: { id: true, businessId: true },
    });
    if (!bench) throw new ForbiddenError();
    access.assertOwned(bench);
  }

  return db.workforceOutreachTask.create({
    data: {
      businessId: access.businessId,
      status: input.approve ? "APPROVED" : "DRAFT",
      kind: input.kind,
      jobId: input.jobId ?? null,
      benchWorkerId: input.benchWorkerId ?? null,
      missingSkills: serializeSkillList(input.missingSkills),
      missingMinutes: input.missingMinutes ?? null,
      explanation: input.explanation.slice(0, 500),
      createdByMembershipId: access.workspace.membership.id,
      approvedByMembershipId: input.approve ? access.workspace.membership.id : null,
    },
  });
}

export function parseProfileSkills(raw: string[]): Array<{
  skillKey: string;
  proficiency: WorkforceProgression;
}> {
  return parseSkillList(raw.join(",")).map((skillKey) => ({
    skillKey,
    proficiency: parseWorkforceProgression("CAPABLE"),
  }));
}

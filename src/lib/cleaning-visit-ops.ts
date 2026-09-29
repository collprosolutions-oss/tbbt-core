/**
 * Cleaning visit workflow mutations.
 *
 * OWNER sets cadence on the existing Job. The assigned worker updates the
 * crew checklist and records VISIT_COMPLETED or RE_CLEAN_REQUESTED.
 * Never creates Job rows, never sends customer messages, never writes
 * CRM or payment records, and never invents a quality stamp.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import {
  ASSIGNED_WORKER_ONLY_MESSAGE,
  CLEANING_VISIT_ONLY_MESSAGE,
  OWNER_SETS_CADENCE_MESSAGE,
  START_BEFORE_COMPLETE_MESSAGE,
  checklistFromProcedureSteps,
  cleaningVisitWorkflowEligible,
  ownerCadencePlan,
  packCrewChecklist,
  parseChecklistJson,
  parseRecordedVisitOutcome,
  resolveJobTradeCode,
  serializeChecklist,
  toggleChecklistItem,
  nextOccurrenceForCadence,
  type CrewChecklistItem,
} from "@/lib/cleaning-visit-workflow";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import {
  completeJobWithRunningTimeSafetyInTransaction,
  isTimeCardError,
  lockTenantOwnedJob,
  timeCardErrorMessage,
} from "@/lib/time-card-ops";
import { parseRecurrenceCadence } from "@/lib/recurrence";

type Db = PrismaClient | Prisma.TransactionClient;

export class CleaningVisitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleaningVisitError";
  }
}

export function cleaningVisitErrorMessage(error: unknown, fallback: string) {
  if (error instanceof CleaningVisitError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

export type AssignedVisitActor = {
  businessId: string;
  membershipId: string;
};

const JOB_TRADE_SELECT = {
  id: true,
  businessId: true,
  status: true,
  scheduledAt: true,
  assignedMembershipId: true,
  serviceIntent: true,
  recurrenceCadence: true,
  recurrenceStatus: true,
  nextOccurrenceAt: true,
  estimate: {
    select: {
      serviceRequest: { select: { tradeCode: true } },
      lineItems: {
        select: { serviceCatalogItem: { select: { tradeCode: true } } },
      },
    },
  },
} as const;

type JobTradeRow = Prisma.JobGetPayload<{ select: typeof JOB_TRADE_SELECT }>;

function jobTradeCode(job: JobTradeRow) {
  return resolveJobTradeCode({
    requestTradeCode: job.estimate?.serviceRequest?.tradeCode,
    catalogTradeCodes: (job.estimate?.lineItems ?? []).map(
      (line) => line.serviceCatalogItem?.tradeCode,
    ),
  });
}

function assertCleaningJob(job: JobTradeRow) {
  if (!cleaningVisitWorkflowEligible(jobTradeCode(job))) {
    throw new CleaningVisitError(CLEANING_VISIT_ONLY_MESSAGE);
  }
}

async function loadScopedJob(db: Db, businessId: string, jobId: string) {
  return db.job.findFirst({
    where: { id: jobId, businessId },
    select: JOB_TRADE_SELECT,
  });
}

async function requireOwnedCleaningJob(
  db: Db,
  access: BusinessAccess,
  jobId: string,
) {
  const job = access.assertOwned(await loadScopedJob(db, access.businessId, jobId));
  assertCleaningJob(job);
  return job;
}

async function requireAssignedCleaningJob(
  db: Db,
  actor: AssignedVisitActor,
  jobId: string,
) {
  const job = await db.job.findFirst({
    where: {
      id: jobId,
      businessId: actor.businessId,
      assignedMembershipId: actor.membershipId,
    },
    select: JOB_TRADE_SELECT,
  });
  if (!job) {
    throw new CleaningVisitError(ASSIGNED_WORKER_ONLY_MESSAGE);
  }
  assertCleaningJob(job);
  return job;
}

async function loadApprovedCleaningProcedure(
  db: Db,
  businessId: string,
  procedureId: string,
) {
  const procedure = await db.operatingProcedure.findFirst({
    where: {
      id: procedureId,
      businessId,
      archived: false,
      approvalState: "APPROVED",
      OR: [{ tradeCode: "CLEANING" }, { tradeCode: null }],
    },
    include: { steps: { orderBy: { sortOrder: "asc" } } },
  });
  if (!procedure || procedure.steps.length === 0) {
    throw new CleaningVisitError("Choose an approved Cleaning checklist.");
  }
  return procedure;
}

function checklistForProcedure(procedure: {
  steps: Array<{ id: string; title: string; required: boolean }>;
}): CrewChecklistItem[] {
  const items = checklistFromProcedureSteps(procedure.steps);
  if (items.length === 0) {
    throw new CleaningVisitError("That checklist has no steps.");
  }
  return items;
}

async function upsertVisitRecord(
  db: Db,
  input: {
    businessId: string;
    jobId: string;
    procedureId?: string | null;
    checklist: CrewChecklistItem[];
  },
) {
  return db.jobCrewVisit.upsert({
    where: { jobId: input.jobId },
    create: {
      businessId: input.businessId,
      jobId: input.jobId,
      procedureId: input.procedureId ?? null,
      checklistJson: serializeChecklist(input.checklist),
      outcomeStatus: "NONE",
    },
    update: {
      procedureId: input.procedureId ?? null,
      checklistJson: serializeChecklist(input.checklist),
    },
  });
}

export async function setCleaningVisitCadence(
  db: PrismaClient,
  access: BusinessAccess,
  input: { jobId: string; cadence: string; timeZone?: string },
) {
  if (access.workspace.role !== "OWNER") {
    throw new ForbiddenError(OWNER_SETS_CADENCE_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
  const job = await requireOwnedCleaningJob(db, access, input.jobId);
  const planned = ownerCadencePlan(input.cadence);
  if (!planned.ok) {
    throw new CleaningVisitError(planned.error);
  }
  const plan = planned.plan;
  const timeZone =
    input.timeZone ?? resolveBusinessTimeZone(access.workspace.business);
  const nextOccurrenceAt =
    plan.serviceIntent === "RECURRING"
      ? nextOccurrenceForCadence({
          scheduledAt: job.scheduledAt,
          cadence: parseRecurrenceCadence(plan.recurrenceCadence),
          existingNext: null,
          timeZone,
        })
      : null;

  await db.$transaction(async (tx) => {
    const locked = await lockTenantOwnedJob(tx, access.businessId, job.id);
    if (!locked) {
      throw new CleaningVisitError("That job could not be updated.");
    }
    await tx.job.update({
      where: { id: job.id },
      data: {
        serviceIntent: plan.serviceIntent,
        recurrenceCadence: plan.recurrenceCadence,
        recurrenceStatus: plan.recurrenceStatus,
        nextOccurrenceAt,
      },
    });

    const existing = await tx.jobCrewVisit.findFirst({
      where: { jobId: job.id, businessId: access.businessId },
    });
    if (!existing) {
      await upsertVisitRecord(tx, {
        businessId: access.businessId,
        jobId: job.id,
        checklist: packCrewChecklist(),
      });
    }
  });

  return db.job.findFirstOrThrow({
    where: { id: job.id, businessId: access.businessId },
    select: {
      id: true,
      serviceIntent: true,
      recurrenceCadence: true,
      recurrenceStatus: true,
      nextOccurrenceAt: true,
    },
  });
}

export async function attachCleaningCrewChecklist(
  db: PrismaClient,
  access: BusinessAccess,
  input: { jobId: string; procedureId: string },
) {
  if (access.workspace.role !== "OWNER") {
    throw new ForbiddenError(OWNER_SETS_CADENCE_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
  const job = await requireOwnedCleaningJob(db, access, input.jobId);
  const procedure = await loadApprovedCleaningProcedure(
    db,
    access.businessId,
    input.procedureId,
  );
  return db.$transaction(async (tx) => {
    const locked = await lockTenantOwnedJob(tx, access.businessId, job.id);
    if (!locked) {
      throw new CleaningVisitError("That job could not be updated.");
    }
    return upsertVisitRecord(tx, {
      businessId: access.businessId,
      jobId: job.id,
      procedureId: procedure.id,
      checklist: checklistForProcedure(procedure),
    });
  });
}

export async function setAssignedChecklistItem(
  db: PrismaClient,
  actor: AssignedVisitActor,
  input: {
    jobId: string;
    itemKey: string;
    checked: boolean;
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
  },
) {
  const job = await requireAssignedCleaningJob(db, actor, input.jobId);
  const visit = await db.jobCrewVisit.findFirst({
    where: { jobId: job.id, businessId: actor.businessId },
  });
  if (!visit) {
    throw new CleaningVisitError("The owner has not set a visit cadence yet.");
  }
  const items = parseChecklistJson(visit.checklistJson);
  if (!items.some((item) => item.key === input.itemKey)) {
    throw new CleaningVisitError("That checklist item is not on this visit.");
  }

  if (input.afterInitialRead) {
    await input.afterInitialRead();
  }

  return db.$transaction(async (tx) => {
    const locked = await lockTenantOwnedJob(tx, actor.businessId, job.id);
    if (!locked || locked.assignedMembershipId !== actor.membershipId) {
      throw new CleaningVisitError(ASSIGNED_WORKER_ONLY_MESSAGE);
    }

    const lockedVisit = await tx.jobCrewVisit.findFirst({
      where: { jobId: job.id, businessId: actor.businessId },
    });
    if (!lockedVisit) {
      throw new CleaningVisitError("The owner has not set a visit cadence yet.");
    }
    const lockedItems = parseChecklistJson(lockedVisit.checklistJson);
    if (!lockedItems.some((item) => item.key === input.itemKey)) {
      throw new CleaningVisitError("That checklist item is not on this visit.");
    }
    const next = toggleChecklistItem(lockedItems, input.itemKey, input.checked);
    return tx.jobCrewVisit.update({
      where: { id: lockedVisit.id },
      data: { checklistJson: serializeChecklist(next) },
    });
  });
}

export async function recordAssignedVisitOutcome(
  db: PrismaClient,
  actor: AssignedVisitActor,
  input: {
    jobId: string;
    outcomeStatus: string;
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
  },
) {
  const outcome = parseRecordedVisitOutcome(input.outcomeStatus);
  if (!outcome) {
    throw new CleaningVisitError("Choose visit completed or requested re-clean.");
  }
  const job = await requireAssignedCleaningJob(db, actor, input.jobId);

  if (outcome === "VISIT_COMPLETED" && job.status !== "IN_PROGRESS" && job.status !== "COMPLETED") {
    throw new CleaningVisitError(START_BEFORE_COMPLETE_MESSAGE);
  }

  if (input.afterInitialRead) {
    await input.afterInitialRead();
  }

  try {
    return await db.$transaction(async (tx) => {
      const locked = await lockTenantOwnedJob(tx, actor.businessId, job.id);
      if (!locked || locked.assignedMembershipId !== actor.membershipId) {
        throw new CleaningVisitError(ASSIGNED_WORKER_ONLY_MESSAGE);
      }
      if (
        outcome === "VISIT_COMPLETED" &&
        locked.status !== "IN_PROGRESS" &&
        locked.status !== "COMPLETED"
      ) {
        throw new CleaningVisitError(START_BEFORE_COMPLETE_MESSAGE);
      }

      let visit = await tx.jobCrewVisit.findFirst({
        where: { jobId: job.id, businessId: actor.businessId },
      });
      if (!visit) {
        visit = await upsertVisitRecord(tx, {
          businessId: actor.businessId,
          jobId: job.id,
          checklist: packCrewChecklist(),
        });
      }

      const recorded = await tx.jobCrewVisit.update({
        where: { id: visit.id },
        data: {
          outcomeStatus: outcome,
          outcomeRecordedAt: new Date(),
          outcomeRecordedByMembershipId: actor.membershipId,
        },
      });

      let jobStatus = locked.status;
      if (outcome === "VISIT_COMPLETED" && locked.status === "IN_PROGRESS") {
        const completed = await completeJobWithRunningTimeSafetyInTransaction(tx, {
          businessId: actor.businessId,
          jobId: job.id,
          actorMembershipId: actor.membershipId,
        });
        if (!completed.ok) {
          throw new CleaningVisitError(completed.error);
        }
        jobStatus = "COMPLETED";
      }

      return { visit: recorded, jobStatus };
    });
  } catch (error) {
    if (isTimeCardError(error)) {
      throw new CleaningVisitError(
        timeCardErrorMessage(error, "That visit outcome could not be recorded."),
      );
    }
    throw error;
  }
}

export async function countBusinessJobs(db: Db, businessId: string) {
  return db.job.count({ where: { businessId } });
}

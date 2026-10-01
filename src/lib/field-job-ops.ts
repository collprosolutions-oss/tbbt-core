/**
 * Assigned-job Field writes shared by the web Field actions.
 *
 * The server action still derives the workspace and SaaS entitlement.
 * These helpers re-read the assigned Job, then lock it and recheck
 * businessId, assignment, job status, and the exact active membership
 * immediately before mutation so a deactivated MEMBER cannot commit
 * after a valid initial read. Start uses the same canonical running-time
 * write as native field start. Problem reports never complete, cancel,
 * or reschedule the Job and never send a customer message.
 */
import type { PrismaClient } from "@prisma/client";
import {
  CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT,
  startJobRequiresCustomerConfirmation,
} from "@/lib/appointment-confirmation";
import { exactActiveMembershipHeld } from "@/lib/exact-active-membership";
import { evaluateStartJob } from "@/lib/job-lifecycle";
import {
  isTimeCardError,
  lockTenantOwnedJob,
  startJobWithRunningTimeSafetyInTransaction,
  timeCardErrorMessage,
} from "@/lib/time-card-ops";

export const FIELD_JOB_NOT_ASSIGNED = "That job isn't assigned to you.";
export const FIELD_JOB_PROBLEM_CLOSED = "This job cannot receive a problem report.";
export const FIELD_JOB_PROBLEM_DESCRIBE = "Describe the problem.";
export const FIELD_JOB_PROBLEM_DESCRIPTION_MAX = 2000;
export const FIELD_JOB_PROBLEM_REPORT_STATUSES = [
  "SCHEDULED",
  "UNSCHEDULED",
  "IN_PROGRESS",
  "COMPLETED",
] as const;

export function assignedJobCanReceiveProblemReport(status: string) {
  return (FIELD_JOB_PROBLEM_REPORT_STATUSES as readonly string[]).includes(status);
}

export function normalizeAssignedJobProblemDescription(description: string) {
  return description.trim().slice(0, FIELD_JOB_PROBLEM_DESCRIPTION_MAX);
}

const START_AUTHORIZE_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  status: true,
  scheduledAt: true,
  scheduledDurationMinutes: true,
  appointmentConfirmationStatus: true,
  appointmentProposalId: true,
  appointmentConfirmedForProposalId: true,
  appointmentConfirmationSource: true,
  appointmentChangeRequestNote: true,
  propertyAccessMethod: true,
  propertyAccessInstructions: true,
  propertyAccessContactName: true,
  propertyAccessContactInfo: true,
  propertyAccessPickupLocation: true,
  propertyAccessNote: true,
} as const;

type AssignedFieldActor = {
  businessId: string;
  membershipId: string;
};

export type StartAssignedFieldJobResult =
  | {
      ok: true;
      alreadyStarted: boolean;
      jobId: string;
      businessId: string;
      customerId: string | null;
    }
  | { ok: false; error: string };

export async function startAssignedFieldJob(
  db: PrismaClient,
  actor: AssignedFieldActor,
  jobId: string,
  options?: {
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
  },
): Promise<StartAssignedFieldJobResult> {
  const assigned = await db.job.findFirst({
    where: {
      id: jobId,
      businessId: actor.businessId,
      assignedMembershipId: actor.membershipId,
    },
    select: START_AUTHORIZE_SELECT,
  });
  if (!assigned) {
    return { ok: false, error: FIELD_JOB_NOT_ASSIGNED };
  }

  if (options?.afterInitialRead) {
    await options.afterInitialRead();
  }

  return db.$transaction(async (tx) => {
    const locked = await lockTenantOwnedJob(tx, actor.businessId, assigned.id);
    if (!locked || locked.assignedMembershipId !== actor.membershipId) {
      return { ok: false as const, error: FIELD_JOB_NOT_ASSIGNED };
    }
    if (!(await exactActiveMembershipHeld(tx, actor))) {
      return { ok: false as const, error: FIELD_JOB_NOT_ASSIGNED };
    }

    const current = await tx.job.findFirst({
      where: { id: locked.id, businessId: locked.businessId },
      select: START_AUTHORIZE_SELECT,
    });
    if (!current) {
      return { ok: false as const, error: FIELD_JOB_NOT_ASSIGNED };
    }

    const lifecycle = evaluateStartJob(current.status);
    if (!lifecycle.ok) {
      return { ok: false as const, error: lifecycle.error };
    }
    if (lifecycle.nextStatus && startJobRequiresCustomerConfirmation(current)) {
      return { ok: false as const, error: CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT };
    }

    try {
      const started = await startJobWithRunningTimeSafetyInTransaction(tx, {
        businessId: locked.businessId,
        jobId: locked.id,
        actorMembershipId: actor.membershipId,
      });
      if (!started.ok) {
        return { ok: false as const, error: started.error };
      }
      return {
        ok: true as const,
        alreadyStarted: started.alreadyStarted,
        jobId: current.id,
        businessId: current.businessId,
        customerId: current.customerId,
      };
    } catch (error) {
      if (isTimeCardError(error)) {
        return {
          ok: false as const,
          error: timeCardErrorMessage(error, FIELD_JOB_NOT_ASSIGNED),
        };
      }
      throw error;
    }
  });
}

export async function reportAssignedJobProblem(
  db: PrismaClient,
  actor: AssignedFieldActor,
  input: {
    jobId: string;
    description: string;
    afterInitialRead?: () => Promise<void>;
  },
) {
  const description = normalizeAssignedJobProblemDescription(input.description);
  if (!description) {
    return { ok: false as const, error: FIELD_JOB_PROBLEM_DESCRIBE };
  }

  const assigned = await db.job.findFirst({
    where: {
      id: input.jobId,
      businessId: actor.businessId,
      assignedMembershipId: actor.membershipId,
    },
    select: {
      id: true,
      businessId: true,
      assignedMembershipId: true,
      status: true,
    },
  });
  if (!assigned) {
    return { ok: false as const, error: FIELD_JOB_NOT_ASSIGNED };
  }
  if (!assignedJobCanReceiveProblemReport(assigned.status)) {
    return { ok: false as const, error: FIELD_JOB_PROBLEM_CLOSED };
  }

  if (input.afterInitialRead) {
    await input.afterInitialRead();
  }

  return db.$transaction(async (tx) => {
    const locked = await lockTenantOwnedJob(tx, actor.businessId, assigned.id);
    if (
      !locked ||
      locked.businessId !== actor.businessId ||
      locked.assignedMembershipId !== actor.membershipId
    ) {
      return { ok: false as const, error: FIELD_JOB_NOT_ASSIGNED };
    }
    if (!assignedJobCanReceiveProblemReport(locked.status)) {
      return { ok: false as const, error: FIELD_JOB_PROBLEM_CLOSED };
    }
    if (!(await exactActiveMembershipHeld(tx, actor))) {
      return { ok: false as const, error: FIELD_JOB_NOT_ASSIGNED };
    }

    const existing = await tx.jobProblemReport.findFirst({
      where: {
        businessId: locked.businessId,
        jobId: locked.id,
        membershipId: actor.membershipId,
        description,
        status: "OPEN",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (existing) {
      return { ok: true as const, alreadyRecorded: true, report: existing };
    }

    const report = await tx.jobProblemReport.create({
      data: {
        businessId: locked.businessId,
        jobId: locked.id,
        membershipId: actor.membershipId,
        description,
      },
    });
    return { ok: true as const, alreadyRecorded: false, report };
  });
}

export async function requestAssignedJobAdditionalWork(
  db: PrismaClient,
  actor: AssignedFieldActor,
  input: {
    jobId: string;
    description: string;
    afterInitialRead?: () => Promise<void>;
  },
) {
  const assigned = await db.job.findFirst({
    where: {
      id: input.jobId,
      businessId: actor.businessId,
      assignedMembershipId: actor.membershipId,
    },
    select: { id: true },
  });
  if (!assigned) {
    return { ok: false as const, error: FIELD_JOB_NOT_ASSIGNED };
  }

  if (input.afterInitialRead) {
    await input.afterInitialRead();
  }

  return db.$transaction(async (tx) => {
    const locked = await lockTenantOwnedJob(tx, actor.businessId, assigned.id);
    if (!locked || locked.assignedMembershipId !== actor.membershipId) {
      return { ok: false as const, error: FIELD_JOB_NOT_ASSIGNED };
    }
    if (!(await exactActiveMembershipHeld(tx, actor))) {
      return { ok: false as const, error: FIELD_JOB_NOT_ASSIGNED };
    }

    const request = await tx.additionalWorkRequest.create({
      data: {
        businessId: actor.businessId,
        jobId: locked.id,
        description: input.description,
        source: "EMPLOYEE",
      },
    });
    return { ok: true as const, request };
  });
}

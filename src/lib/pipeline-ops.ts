/**
 * Pipeline mutations -- the real write path used by server actions and
 * the focused Pipeline check. Every function takes an already-authorized
 * BusinessAccess and re-checks tenant + role before writing. Never trusts
 * a browser-supplied businessId.
 *
 * These writes only touch PipelineOpportunity (owner-managed sales state).
 * They never create or delete Customer, ServiceRequest, Estimate, or Job
 * records, and they never rewrite estimate versions.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  allowedOwnerStages,
  isOwnerManagedStage,
  isPipelineLossReason,
  parseOpportunityKey,
  parsePipelineDate,
  resolvePipelineStage,
  type PipelineOwnerStage,
} from "@/lib/pipeline";

type Db = PrismaClient | Prisma.TransactionClient;

export class PipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineError";
  }
}

export function pipelineErrorMessage(error: unknown, fallback: string) {
  if (error instanceof PipelineError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

type OpportunityAnchor = {
  serviceRequestId: string | null;
  standaloneEstimateId: string | null;
  estimateStatus: string | null;
  hasJob: boolean;
  existing: {
    id: string;
    businessId: string;
    ownerStage: string | null;
    followUpOn: Date | null;
    lossReason: string | null;
    lossReasonNote: string | null;
    notes: string | null;
  } | null;
};

async function resolveAnchor(
  db: Db,
  access: BusinessAccess,
  opportunityKey: string,
): Promise<OpportunityAnchor> {
  const parsed = parseOpportunityKey(opportunityKey);
  if (!parsed) {
    throw new PipelineError("That opportunity could not be found.");
  }

  if (parsed.jobId) {
    const job = access.assertOwned(
      await db.job.findFirst({
        where: { id: parsed.jobId, ...access.scope },
        select: { id: true, businessId: true, estimateId: true },
      }),
    );
    if (job.estimateId) {
      return resolveAnchor(db, access, `estimate:${job.estimateId}`);
    }
    throw new PipelineError("A won job cannot be moved to an owner-managed sales stage.");
  }

  if (parsed.serviceRequestId) {
    const request = access.assertOwned(
      await db.serviceRequest.findFirst({
        where: { id: parsed.serviceRequestId, ...access.scope },
        select: {
          id: true,
          businessId: true,
          estimates: {
            select: { status: true, jobs: { select: { id: true }, take: 1 } },
          },
          pipelineOpportunity: true,
        },
      }),
    );
    const hasJob = request.estimates.some((estimate) => estimate.jobs.length > 0);
    const estimateStatus = request.estimates.some((estimate) => estimate.status === "APPROVED")
      ? "APPROVED"
      : request.estimates.some((estimate) => estimate.status === "SENT")
        ? "SENT"
        : request.estimates.some((estimate) => estimate.status === "DRAFT")
          ? "DRAFT"
          : null;
    return {
      serviceRequestId: request.id,
      standaloneEstimateId: null,
      estimateStatus,
      hasJob,
      existing: request.pipelineOpportunity,
    };
  }

  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: parsed.estimateId, ...access.scope },
      select: {
        id: true,
        businessId: true,
        status: true,
        serviceRequestId: true,
        jobs: { select: { id: true }, take: 1 },
        pipelineOpportunity: true,
      },
    }),
  );

  if (estimate.serviceRequestId) {
    return resolveAnchor(db, access, `request:${estimate.serviceRequestId}`);
  }

  return {
    serviceRequestId: null,
    standaloneEstimateId: estimate.id,
    estimateStatus: estimate.status,
    hasJob: estimate.jobs.length > 0,
    existing: estimate.pipelineOpportunity,
  };
}

async function upsertState(
  db: Db,
  access: BusinessAccess,
  anchor: OpportunityAnchor,
  data: {
    ownerStage?: string | null;
    followUpOn?: Date | null;
    lossReason?: string | null;
    lossReasonNote?: string | null;
    notes?: string | null;
  },
) {
  if (anchor.existing) {
    return db.pipelineOpportunity.update({
      where: { id: access.assertOwned(anchor.existing).id },
      data,
    });
  }

  return db.pipelineOpportunity.create({
    data: {
      businessId: access.businessId,
      serviceRequestId: anchor.serviceRequestId,
      standaloneEstimateId: anchor.standaloneEstimateId,
      ownerStage: data.ownerStage ?? null,
      followUpOn: data.followUpOn ?? null,
      lossReason: data.lossReason ?? null,
      lossReasonNote: data.lossReasonNote ?? null,
      notes: data.notes ?? null,
    },
  });
}

export type UpdatePipelineStageInput = {
  opportunityKey: string;
  ownerStage: string;
  lossReason?: string;
  lossReasonNote?: string;
};

export async function updatePipelineStage(
  db: Db,
  access: BusinessAccess,
  input: UpdatePipelineStageInput,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_PIPELINE);

  const anchor = await resolveAnchor(db, access, input.opportunityKey);
  const facts = {
    ownerStage: input.ownerStage,
    estimateStatus: anchor.estimateStatus,
    hasJob: anchor.hasJob,
  };

  if (input.ownerStage === "") {
    if (anchor.hasJob || anchor.estimateStatus === "APPROVED") {
      throw new PipelineError("An approved estimate or job stays Won.");
    }
    if (!anchor.existing) return null;
    return upsertState(db, access, anchor, {
      ownerStage: null,
      lossReason: null,
      lossReasonNote: null,
    });
  }

  if (!isOwnerManagedStage(input.ownerStage)) {
    throw new PipelineError("That sales stage is derived from the request, estimate, or job and cannot be set by hand.");
  }

  const allowed = allowedOwnerStages({
    ownerStage: null,
    estimateStatus: anchor.estimateStatus,
    hasJob: anchor.hasJob,
  });
  if (!allowed.includes(input.ownerStage as PipelineOwnerStage)) {
    if (anchor.hasJob || anchor.estimateStatus === "APPROVED") {
      throw new PipelineError("An approved estimate or job stays Won and cannot be marked Lost.");
    }
    throw new PipelineError("That sales stage would contradict the current estimate or job.");
  }

  const displayed = resolvePipelineStage(facts);
  if (displayed === "WON" && input.ownerStage === "LOST") {
    throw new PipelineError("An approved estimate or job stays Won and cannot be marked Lost.");
  }

  let lossReason: string | null = null;
  let lossReasonNote: string | null = null;
  if (input.ownerStage === "LOST") {
    const reason = input.lossReason?.trim() ?? "";
    if (reason && !isPipelineLossReason(reason)) {
      throw new PipelineError("Choose a valid loss reason, or leave it blank.");
    }
    lossReason = reason || null;
    lossReasonNote = input.lossReasonNote?.trim() || null;
  }

  return upsertState(db, access, anchor, {
    ownerStage: input.ownerStage,
    lossReason,
    lossReasonNote,
  });
}

export type UpdatePipelineFollowUpInput = {
  opportunityKey: string;
  followUpOn?: string;
};

export async function updatePipelineFollowUp(
  db: Db,
  access: BusinessAccess,
  input: UpdatePipelineFollowUpInput,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_PIPELINE);

  const anchor = await resolveAnchor(db, access, input.opportunityKey);
  const raw = input.followUpOn?.trim() ?? "";
  let followUpOn: Date | null = null;
  if (raw) {
    followUpOn = parsePipelineDate(raw);
    if (!followUpOn) {
      throw new PipelineError("Enter a valid follow-up date.");
    }
  }

  return upsertState(db, access, anchor, { followUpOn });
}

export type UpdatePipelineNotesInput = {
  opportunityKey: string;
  notes?: string;
};

export async function updatePipelineNotes(
  db: Db,
  access: BusinessAccess,
  input: UpdatePipelineNotesInput,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_PIPELINE);
  const anchor = await resolveAnchor(db, access, input.opportunityKey);
  return upsertState(db, access, anchor, {
    notes: input.notes?.trim() || null,
  });
}

export async function assertPipelineReadable(
  db: Db,
  access: BusinessAccess,
  opportunityKey: string,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_PIPELINE);
  return resolveAnchor(db, access, opportunityKey);
}

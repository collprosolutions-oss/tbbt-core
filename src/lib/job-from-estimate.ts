/**
 * Approved-estimate → Job conversion. One root conversion Job per
 * Estimate (recurring / next-booking / corrective copies may still
 * share estimateId). Concurrent callers lock the Estimate, re-read,
 * and the unique-index loser re-reads the winner.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { OPTION_JOB_REQUIRED_MESSAGE } from "@/lib/estimate-options";
import { attachPurchaseListToCreatedJob } from "@/lib/materials/purchase";
import { jobRecurrenceFromServiceRequest } from "@/lib/recurrence";

const CONVERSION_UNIQUE_INDEX = "Job_estimateId_conversion_unique";

export const jobFromEstimateTestHooks: {
  afterEstimateLock?: (input: { estimateId: string }) => Promise<void> | void;
  beforeJobCreate?: (input: { estimateId: string }) => Promise<void> | void;
} = {};

export function isJobEstimateConversionUniqueViolation(error: unknown): boolean {
  const unique = prismaUniqueViolation(error);
  if (!unique) return false;
  const model = String(unique.meta?.modelName ?? "");
  const target = unique.meta?.target;
  const parts = (Array.isArray(target) ? target : target != null ? [target] : []).map(
    (value) => String(value),
  );
  const joined = [...parts, unique.message ?? ""].join(" ").toLowerCase();
  if (joined.includes(CONVERSION_UNIQUE_INDEX.toLowerCase())) return true;
  if (joined.includes("estimateid_conversion")) return true;
  return model === "Job" && parts.some((part) => /^estimateid$/i.test(part));
}

function prismaUniqueViolation(
  error: unknown,
): Prisma.PrismaClientKnownRequestError | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return error;
  }
  if (error && typeof error === "object" && "cause" in error) {
    return prismaUniqueViolation((error as { cause: unknown }).cause);
  }
  return null;
}

export type CreateJobFromApprovedEstimateResult =
  | { ok: true; jobId: string; reused: boolean }
  | { ok: false; error: string };

export async function createJobFromApprovedEstimate(
  db: PrismaClient,
  access: BusinessAccess,
  estimateId: string,
): Promise<CreateJobFromApprovedEstimateResult> {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  const trimmed = estimateId.trim();
  if (!trimmed) {
    return { ok: false, error: "That estimate could not become a job." };
  }

  try {
    return await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`
        SELECT id FROM "Estimate"
        WHERE id = ${trimmed} AND "businessId" = ${access.businessId}
        FOR UPDATE
      `;
      await jobFromEstimateTestHooks.afterEstimateLock?.({ estimateId: trimmed });

      const estimate = access.assertOwned(
        await tx.estimate.findFirst({
          where: { id: trimmed, ...access.scope },
        }),
      );

      if (estimate.status !== "APPROVED") {
        return { ok: false, error: "Only an approved estimate can become a job." };
      }

      const frozenOptions = await tx.estimateVersionOption.count({
        where: {
          businessId: access.businessId,
          estimateVersionId: estimate.approvedVersionId ?? "",
        },
      });
      if (frozenOptions > 0 && !estimate.approvedOptionId) {
        return { ok: false, error: OPTION_JOB_REQUIRED_MESSAGE };
      }

      const existing = await tx.job.findFirst({
        where: {
          ...access.scope,
          estimateId: estimate.id,
          recurrenceSourceJobId: null,
          nextBookingSourceJobId: null,
          correctiveCleanSourceJobId: null,
        },
        select: { id: true },
      });
      if (existing) {
        return { ok: true, jobId: existing.id, reused: true };
      }

      let propertyId: string | null = null;
      if (estimate.propertyId) {
        const property = await tx.property.findFirst({
          where: {
            id: estimate.propertyId,
            ...access.scope,
            ...(estimate.customerId ? { customerId: estimate.customerId } : {}),
          },
        });
        if (property) {
          access.assertOwned(property);
          propertyId = property.id;
        }
      }

      let sourceRequest: {
        serviceIntent: string;
        recurrenceCadence: string;
        propertyId: string | null;
      } | null = null;
      if (estimate.serviceRequestId) {
        const serviceRequest = access.assertOwned(
          await tx.serviceRequest.findFirst({
            where: { id: estimate.serviceRequestId, ...access.scope },
            select: {
              id: true,
              businessId: true,
              propertyId: true,
              serviceIntent: true,
              recurrenceCadence: true,
            },
          }),
        );
        sourceRequest = serviceRequest;
        if (!propertyId) {
          propertyId = serviceRequest.propertyId;
        }
      }

      const recurrence = jobRecurrenceFromServiceRequest(sourceRequest);
      await jobFromEstimateTestHooks.beforeJobCreate?.({ estimateId: estimate.id });

      let job: { id: string };
      try {
        job = await tx.job.create({
          data: {
            businessId: access.businessId,
            customerId: estimate.customerId,
            propertyId,
            estimateId: estimate.id,
            approvedEstimateVersionId: estimate.approvedVersionId,
            approvedEstimateOptionId: estimate.approvedOptionId,
            projectToken: randomUUID(),
            status: "UNSCHEDULED",
            leadSource: estimate.leadSource,
            campaignId: estimate.campaignId,
            serviceIntent: recurrence.serviceIntent,
            recurrenceCadence: recurrence.recurrenceCadence,
            recurrenceStatus: recurrence.recurrenceStatus,
          },
          select: { id: true },
        });
      } catch (error) {
        if (!isJobEstimateConversionUniqueViolation(error)) {
          throw error;
        }
        const winner = await tx.job.findFirst({
          where: {
            ...access.scope,
            estimateId: estimate.id,
            recurrenceSourceJobId: null,
            nextBookingSourceJobId: null,
            correctiveCleanSourceJobId: null,
          },
          select: { id: true },
        });
        if (!winner) throw error;
        return { ok: true, jobId: winner.id, reused: true };
      }

      await attachPurchaseListToCreatedJob(tx, access, {
        jobId: job.id,
        estimateId: estimate.id,
        estimateVersionId: estimate.approvedVersionId,
      });

      return { ok: true, jobId: job.id, reused: false };
    },
      { timeout: 15_000 },
    );
  } catch (error) {
    if (!isJobEstimateConversionUniqueViolation(error)) {
      throw error;
    }
    const winner = await db.job.findFirst({
      where: {
        ...access.scope,
        estimateId: trimmed,
        recurrenceSourceJobId: null,
        nextBookingSourceJobId: null,
        correctiveCleanSourceJobId: null,
      },
      select: { id: true },
    });
    if (!winner) throw error;
    return { ok: true, jobId: winner.id, reused: true };
  }
}

/**
 * ServiceRequest → Estimate conversion for createEstimate().
 *
 * Founder rule: do not add a global unique constraint on
 * Estimate.serviceRequestId. Multiple estimates may legitimately
 * attach to one ServiceRequest via an explicit separate workflow
 * (createDraftEstimateWithOptionalTemplate and similar writers).
 *
 * The normal conversion action stays idempotent and concurrency-safe:
 * it locks the ServiceRequest FOR UPDATE, re-reads, and returns the
 * earliest existing linked estimate. Simultaneous conversion attempts
 * converge on that row instead of creating duplicates. It does not
 * impose a global one-estimate-per-request product rule.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { persistDraftEstimateTotal } from "@/lib/labor-minimum";
import {
  addRequestDraftLines,
  type RequestDraftSourceItem,
} from "@/lib/request-estimate-draft";
import type { StoredIntakeMeasurement } from "@/lib/intake-quote-handoff";
import type { WorkAreaIntakeRecord } from "@/lib/work-area-intake";
import type { BusinessEstimatingDefaultPayload } from "@/lib/estimating-defaults";

export const estimateFromRequestTestHooks: {
  afterRequestLock?: (input: { serviceRequestId: string }) => Promise<void> | void;
} = {};

export type CreateEstimateFromServiceRequestInput = {
  serviceRequestId: string;
  customerId: string | null;
  propertyId: string | null;
  status: string;
  leadSource: string | null;
  campaignId: string | null;
  sourceItems: RequestDraftSourceItem[];
  workAreaIntake?: WorkAreaIntakeRecord | null;
  measurements: StoredIntakeMeasurement[];
  businessDefaults?: BusinessEstimatingDefaultPayload | null;
};

export async function createEstimateFromServiceRequest(
  db: PrismaClient,
  access: BusinessAccess,
  input: CreateEstimateFromServiceRequestInput,
): Promise<{ id: string; created: boolean }> {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const serviceRequestId = input.serviceRequestId.trim();
  if (!serviceRequestId) {
    throw new Error("That request could not become an estimate.");
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id FROM "ServiceRequest"
      WHERE id = ${serviceRequestId} AND "businessId" = ${access.businessId}
      FOR UPDATE
    `;
    await estimateFromRequestTestHooks.afterRequestLock?.({ serviceRequestId });

    const request = access.assertOwned(
      await tx.serviceRequest.findFirst({
        where: { id: serviceRequestId, ...access.scope },
        select: { id: true, businessId: true, status: true },
      }),
    );

    const existing = await tx.estimate.findFirst({
      where: {
        businessId: access.businessId,
        serviceRequestId: request.id,
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (existing) {
      return { id: existing.id, created: false };
    }

    const created = await tx.estimate.create({
      data: {
        businessId: access.businessId,
        serviceRequestId: request.id,
        customerId: input.customerId,
        propertyId: input.propertyId,
        total: new Prisma.Decimal(0),
        publicToken: randomUUID(),
        leadSource: input.leadSource,
        campaignId: input.campaignId,
      },
    });

    await addRequestDraftLines(tx, {
      businessId: access.businessId,
      estimateId: created.id,
      items: input.sourceItems,
      workAreaIntake: input.workAreaIntake,
      measurements: input.measurements,
      businessDefaults: input.businessDefaults,
    });
    await persistDraftEstimateTotal(tx, created.id, access.businessId);

    if (request.status === "OPEN") {
      await tx.serviceRequest.update({
        where: { id: request.id },
        data: { status: "CONVERTED" },
      });
    }

    return { id: created.id, created: true };
  }, { timeout: 15_000 });
}

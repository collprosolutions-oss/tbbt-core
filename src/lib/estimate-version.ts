import type { Prisma } from "@prisma/client";

/**
 * Immutable estimate version snapshots.
 *
 * A row in EstimateVersion (and its EstimateVersionLineItem children) is
 * created exactly once, at the moment an estimate is successfully sent, and
 * must never be edited or deleted by application code afterward. The only
 * field ever written after creation is EstimateVersion.approvedAt, and only
 * on the single version a customer actually approved (see
 * `approveEstimate` in `src/app/actions/public-estimate.ts`).
 *
 * Do not add helpers here that mutate snapshot fields on an existing
 * EstimateVersion/EstimateVersionLineItem row.
 */

type TransactionClient = Prisma.TransactionClient;

/**
 * Creates the immutable SENT snapshot for an estimate. Callers MUST invoke
 * this only after the DRAFT -> SENT status transition has already
 * succeeded (guarded by a status-checked updateMany), and MUST do so inside
 * the same database transaction as that transition, so a failed snapshot
 * rolls back the SENT status change too.
 */
export async function createEstimateVersionSnapshot(
  tx: TransactionClient,
  input: { estimateId: string; businessId: string },
) {
  const estimate = await tx.estimate.findFirstOrThrow({
    where: { id: input.estimateId, businessId: input.businessId },
    include: {
      customer: { select: { name: true, email: true, phone: true } },
      property: {
        select: {
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
        },
      },
      lineItems: { orderBy: { createdAt: "asc" } },
    },
  });

  const existingVersionCount = await tx.estimateVersion.count({
    where: { estimateId: estimate.id, businessId: input.businessId },
  });
  const versionNumber = existingVersionCount + 1;

  const version = await tx.estimateVersion.create({
    data: {
      businessId: input.businessId,
      estimateId: estimate.id,
      versionNumber,
      total: estimate.total,
      laborMinimumWaived: estimate.laborMinimumWaived,
      laborMinimumAdjustment: estimate.laborMinimumAdjustment,
      customerName: estimate.customer?.name ?? null,
      customerEmail: estimate.customer?.email ?? null,
      customerPhone: estimate.customer?.phone ?? null,
      propertyAddressLine1: estimate.property?.addressLine1 ?? null,
      propertyAddressLine2: estimate.property?.addressLine2 ?? null,
      propertyCity: estimate.property?.city ?? null,
      propertyRegion: estimate.property?.region ?? null,
      propertyPostalCode: estimate.property?.postalCode ?? null,
      lineItems: {
        create: estimate.lineItems.map((item) => ({
          businessId: input.businessId,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          total: item.total,
          type: item.type,
        })),
      },
    },
  });

  return version;
}

/** Latest (highest versionNumber) EstimateVersion for an estimate, if any. */
export async function findCurrentEstimateVersion(
  tx: TransactionClient,
  estimateId: string,
) {
  return tx.estimateVersion.findFirst({
    where: { estimateId },
    orderBy: { versionNumber: "desc" },
  });
}

export type EstimateVersionSnapshot = Prisma.EstimateVersionGetPayload<{
  include: { lineItems: true };
}>;

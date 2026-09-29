import type { Prisma } from "@prisma/client";
import { computeOptionCommercials } from "@/lib/estimate-options";

/**
 * Immutable estimate version snapshots.
 *
 * A row in EstimateVersion (and its EstimateVersionLineItem children) is
 * created exactly once, at the moment an estimate is successfully sent, and
 * must never be edited or deleted by application code afterward. The only
 * field ever written after creation is EstimateVersion.approvedAt, and only
 * on the single version a customer actually approved (see
 * `approveEstimate` in `src/app/actions/public-estimate.ts`). Multi-option
 * sends also create EstimateVersionOption rows; those snapshot fields are
 * immutable except EstimateVersionOption.approvedAt.
 *
 * Do not add helpers here that mutate snapshot fields on an existing
 * EstimateVersion/EstimateVersionLineItem/EstimateVersionOption row.
 */

type TransactionClient = Prisma.TransactionClient;

function mappedFrozenOptionId(
  sourceOptionId: string | null | undefined,
  optionIdBySource: Map<string, string>,
) {
  if (!sourceOptionId) {
    if (optionIdBySource.size > 0) {
      throw new Error("A snapshot line could not be mapped to a frozen priced option.");
    }
    return null;
  }
  const mapped = optionIdBySource.get(sourceOptionId);
  if (!mapped) {
    throw new Error("A snapshot line could not be mapped to a frozen priced option.");
  }
  return mapped;
}

/**
 * Owner-only copy for a historical SENT estimate that predates versioning.
 * Approval stays refused until Return to Draft → Send creates Version 1.
 * Do not fabricate a version at customer approval time.
 */
export const LEGACY_SENT_WITHOUT_VERSION_OWNER_MESSAGE =
  "This older sent estimate has no version snapshot. Return it to Draft and Send again before the customer can approve it. Sending creates Version 1.";

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
      options: { orderBy: { sortOrder: "asc" } },
    },
  });

  const existingVersionCount = await tx.estimateVersion.count({
    where: { estimateId: estimate.id, businessId: input.businessId },
  });
  const versionNumber = existingVersionCount + 1;
  const liveOptions = estimate.options ?? [];

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
      ...(liveOptions.length === 0
        ? {
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
          }
        : {}),
    },
  });

  if (liveOptions.length > 0) {
    const business = await tx.business.findUnique({
      where: { id: input.businessId },
      select: { laborMinimumEnabled: true, laborMinimumAmount: true },
    });
    const laborMin = {
      enabled: Boolean(business?.laborMinimumEnabled),
      amount: business?.laborMinimumAmount ?? null,
      waived: estimate.laborMinimumWaived,
    };
    const optionIdBySource = new Map<string, string>();
    for (const option of liveOptions) {
      const commercials = computeOptionCommercials(
        estimate.lineItems.filter((item) => item.optionId === option.id),
        laborMin,
      );
      const frozen = await tx.estimateVersionOption.create({
        data: {
          businessId: input.businessId,
          estimateVersionId: version.id,
          sourceOptionId: option.id,
          name: option.name,
          sortOrder: option.sortOrder,
          total: commercials.total,
          laborMinimumAdjustment: commercials.laborMinimumAdjustment,
        },
      });
      optionIdBySource.set(option.id, frozen.id);
    }
    if (estimate.lineItems.length > 0) {
      await tx.estimateVersionLineItem.createMany({
        data: estimate.lineItems.map((item) => ({
          businessId: input.businessId,
          estimateVersionId: version.id,
          optionId: mappedFrozenOptionId(item.optionId, optionIdBySource),
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          total: item.total,
          type: item.type,
        })),
      });
    }
  }

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

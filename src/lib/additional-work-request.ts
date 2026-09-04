import type { Prisma, PrismaClient } from "@prisma/client";
import {
  parseSelectedTasks,
  requestedWorkLabels,
  requestedWorkSummary,
} from "@/lib/service-request-work";

const MAX_DESCRIPTION_LENGTH = 2000;

type AdditionalWorkDb = PrismaClient | Prisma.TransactionClient;

export type CreateAdditionalWorkRequestInput = {
  token: string;
  catalogItemIds?: string[];
  catalogQuantities?: Record<string, unknown>;
  includeOther?: boolean;
  otherDescription?: string;
  otherQuantity?: unknown;
  notes?: string;
};

export type CreateAdditionalWorkRequestResult =
  | { ok: true; requestId: string; jobId: string }
  | { ok: false; error: string };

/**
 * Customer Project Portal Additional Work. Resolves the job from
 * projectToken only — never a client-supplied businessId. Catalog IDs
 * must belong to that job's business and be active.
 */
export async function createCustomerAdditionalWorkRequest(
  db: AdditionalWorkDb,
  input: CreateAdditionalWorkRequestInput,
): Promise<CreateAdditionalWorkRequestResult> {
  const token = input.token.trim();
  if (!token) {
    return { ok: false, error: "This project link is not available." };
  }

  const notes = (input.notes ?? "").trim().slice(0, MAX_DESCRIPTION_LENGTH);
  const catalogItemIds = input.catalogItemIds ?? [];
  const includeOther = Boolean(input.includeOther);
  const otherDescription = (input.otherDescription ?? "").trim();

  const job = await db.job.findUnique({
    where: { projectToken: token },
    select: { id: true, businessId: true },
  });
  if (!job) {
    return { ok: false, error: "This project link is not available." };
  }

  const legacyFreeTextOnly =
    catalogItemIds.length === 0 && !includeOther && !otherDescription && notes;

  if (legacyFreeTextOnly) {
    const created = await db.additionalWorkRequest.create({
      data: {
        businessId: job.businessId,
        jobId: job.id,
        description: notes,
        source: "CUSTOMER",
      },
    });
    return { ok: true, requestId: created.id, jobId: job.id };
  }

  const parsed = parseSelectedTasks({
    catalogItemIds,
    catalogQuantities: input.catalogQuantities,
    includeOther,
    otherDescription,
    otherQuantity: input.otherQuantity,
  });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const catalogIds = parsed.tasks
    .filter((task) => task.kind === "catalog")
    .map((task) => task.serviceCatalogItemId);

  let catalogById = new Map<string, { id: string; name: string }>();
  if (catalogIds.length > 0) {
    const catalogItems = await db.serviceCatalogItem.findMany({
      where: {
        id: { in: catalogIds },
        businessId: job.businessId,
        active: true,
      },
      select: { id: true, name: true },
    });
    if (catalogItems.length !== catalogIds.length) {
      return { ok: false, error: "Select a current service from this project." };
    }
    catalogById = new Map(catalogItems.map((item) => [item.id, item]));
  }

  const labels = requestedWorkLabels({
    items: parsed.tasks.map((task) =>
      task.kind === "catalog"
        ? {
            quantity: task.quantity,
            serviceCatalogItem: catalogById.get(task.serviceCatalogItemId) ?? null,
          }
        : {
            quantity: task.quantity,
            customDescription: task.customDescription,
          },
    ),
  });
  const description = notes || requestedWorkSummary(labels, 200) || labels.join(", ");

  const created = await db.additionalWorkRequest.create({
    data: {
      businessId: job.businessId,
      jobId: job.id,
      description,
      source: "CUSTOMER",
      items: {
        create: parsed.tasks.map((task, index) =>
          task.kind === "catalog"
            ? {
                businessId: job.businessId,
                serviceCatalogItemId: task.serviceCatalogItemId,
                customDescription: null,
                quantity: task.quantity,
                sortOrder: index,
              }
            : {
                businessId: job.businessId,
                serviceCatalogItemId: null,
                customDescription: task.customDescription,
                quantity: task.quantity,
                sortOrder: index,
              },
        ),
      },
    },
  });

  return { ok: true, requestId: created.id, jobId: job.id };
}

import type { Prisma, PrismaClient } from "@prisma/client";
import { JOB_PROJECT_LINK_PORTAL_UNAVAILABLE_MESSAGE } from "@/lib/project-link";
import {
  assertLiveLockedProjectToken,
  findLiveJobByProjectToken,
} from "@/lib/project-link-data";
import {
  parseSelectedTasks,
  requestedWorkLabels,
  requestedWorkSummary,
} from "@/lib/service-request-work";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";

const MAX_DESCRIPTION_LENGTH = 2000;

type AdditionalWorkDb = PrismaClient | Prisma.TransactionClient;

/**
 * Test-only barrier. Production never sets this.
 * afterJobLock runs inside the write transaction after lockTenantOwnedJob
 * and before the post-lock live-token re-check.
 */
export const additionalWorkRequestTestHooks: {
  afterJobLock?: (input: { jobId: string; token: string }) => Promise<void> | void;
} = {};

function isPrismaClient(db: AdditionalWorkDb): db is PrismaClient {
  return typeof (db as PrismaClient).$transaction === "function";
}

async function runAdditionalWorkWrite<T>(
  db: AdditionalWorkDb,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (isPrismaClient(db)) {
    return db.$transaction(fn, { timeout: 15_000 });
  }
  return fn(db);
}

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
 *
 * The unlocked live check can race OWNER rotate/revoke, so the write
 * transaction locks the Job and re-validates Job.projectToken before
 * creating the request.
 */
export async function createCustomerAdditionalWorkRequest(
  db: AdditionalWorkDb,
  input: CreateAdditionalWorkRequestInput,
): Promise<CreateAdditionalWorkRequestResult> {
  const token = input.token.trim();
  if (!token) {
    return { ok: false, error: JOB_PROJECT_LINK_PORTAL_UNAVAILABLE_MESSAGE };
  }

  const notes = (input.notes ?? "").trim().slice(0, MAX_DESCRIPTION_LENGTH);
  const catalogItemIds = input.catalogItemIds ?? [];
  const includeOther = Boolean(input.includeOther);
  const otherDescription = (input.otherDescription ?? "").trim();

  const legacyFreeTextOnly =
    catalogItemIds.length === 0 && !includeOther && !otherDescription && notes;

  let parsed: ReturnType<typeof parseSelectedTasks> | null = null;
  if (!legacyFreeTextOnly) {
    parsed = parseSelectedTasks({
      catalogItemIds,
      catalogQuantities: input.catalogQuantities,
      includeOther,
      otherDescription,
      otherQuantity: input.otherQuantity,
    });
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
  }

  return runAdditionalWorkWrite(db, async (tx) => {
    const job = await findLiveJobByProjectToken(tx, token, {
      id: true,
      businessId: true,
    });
    if (!job) {
      return { ok: false, error: JOB_PROJECT_LINK_PORTAL_UNAVAILABLE_MESSAGE };
    }

    const locked = await lockTenantOwnedJob(tx, job.businessId, job.id);
    if (!locked || locked.businessId !== job.businessId) {
      return { ok: false, error: JOB_PROJECT_LINK_PORTAL_UNAVAILABLE_MESSAGE };
    }
    await additionalWorkRequestTestHooks.afterJobLock?.({
      jobId: locked.id,
      token,
    });
    if (
      !(await assertLiveLockedProjectToken(tx, {
        jobId: locked.id,
        businessId: locked.businessId,
        token,
      }))
    ) {
      return { ok: false, error: JOB_PROJECT_LINK_PORTAL_UNAVAILABLE_MESSAGE };
    }

    if (legacyFreeTextOnly) {
      const created = await tx.additionalWorkRequest.create({
        data: {
          businessId: locked.businessId,
          jobId: locked.id,
          description: notes,
          source: "CUSTOMER",
        },
      });
      return { ok: true, requestId: created.id, jobId: locked.id };
    }

    if (!parsed || !parsed.ok) {
      return { ok: false, error: JOB_PROJECT_LINK_PORTAL_UNAVAILABLE_MESSAGE };
    }

    const catalogIds = parsed.tasks
      .filter((task) => task.kind === "catalog")
      .map((task) => task.serviceCatalogItemId);

    let catalogById = new Map<string, { id: string; name: string }>();
    if (catalogIds.length > 0) {
      const catalogItems = await tx.serviceCatalogItem.findMany({
        where: {
          id: { in: catalogIds },
          businessId: locked.businessId,
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

    const created = await tx.additionalWorkRequest.create({
      data: {
        businessId: locked.businessId,
        jobId: locked.id,
        description,
        source: "CUSTOMER",
        items: {
          create: parsed.tasks.map((task, index) =>
            task.kind === "catalog"
              ? {
                  businessId: locked.businessId,
                  serviceCatalogItemId: task.serviceCatalogItemId,
                  customDescription: null,
                  quantity: task.quantity,
                  sortOrder: index,
                }
              : {
                  businessId: locked.businessId,
                  serviceCatalogItemId: null,
                  customDescription: task.customDescription,
                  quantity: task.quantity,
                  sortOrder: index,
                },
          ),
        },
      },
    });

    return { ok: true, requestId: created.id, jobId: locked.id };
  });
}

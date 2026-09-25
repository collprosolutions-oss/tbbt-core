/**
 * Atomic website publish / rollback.
 *
 * Inserts an immutable WebsitePublish row, then moves
 * Business.publishedWebsiteId in the same transaction.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { requireSaasOperatingEntitlement } from "@/lib/saas-billing/entitlement";
import { buildWebsiteSnapshot, WebsitePublishError } from "@/lib/website-engine/builder";
import { parseWebsiteSnapshot, serializeWebsiteSnapshot } from "@/lib/website-engine/snapshot";
import { summarizeWebsiteSnapshotChange } from "@/lib/website-engine/summary";
import { validateWebsiteSnapshot } from "@/lib/website-engine/validate";

type Db = PrismaClient;

export { WebsitePublishError };

function uniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function publishWebsite(
  db: Db,
  access: BusinessAccess,
  input: { idempotencyKey?: string | null } = {},
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  await requireSaasOperatingEntitlement(db, access);

  const key = input.idempotencyKey?.trim() || null;
  if (key) {
    const existing = access.assertOwned(
      await db.websitePublish.findFirst({
        where: { businessId: access.businessId, idempotencyKey: key },
      }),
    );
    if (existing) return existing;
  }

  const snapshot = await buildWebsiteSnapshot(db, access);
  const validated = validateWebsiteSnapshot(snapshot);
  if (!validated.ok) {
    throw new WebsitePublishError(validated.errors[0] ?? "Website snapshot is invalid.");
  }

  const current = await db.business.findFirst({
    where: { id: access.businessId, ...access.scope },
    select: { publishedWebsiteId: true },
  });
  const previousRow = current?.publishedWebsiteId
    ? await db.websitePublish.findFirst({
        where: { id: current.publishedWebsiteId, businessId: access.businessId },
      })
    : null;
  const previous = previousRow ? parseWebsiteSnapshot(previousRow.snapshotJson) : null;
  const summary = summarizeWebsiteSnapshotChange(previous, validated.snapshot);

  const write = async () =>
    db.$transaction(async (tx) => {
      if (key) {
        const raced = await tx.websitePublish.findFirst({
          where: { businessId: access.businessId, idempotencyKey: key },
        });
        if (raced) return raced;
      }
      const latest = await tx.websitePublish.findFirst({
        where: { businessId: access.businessId },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true },
      });
      const created = await tx.websitePublish.create({
        data: {
          businessId: access.businessId,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          schemaVersion: validated.snapshot.schemaVersion,
          snapshotJson: serializeWebsiteSnapshot(validated.snapshot),
          summary,
          publishedByMembershipId: access.workspace.membership.id,
          idempotencyKey: key,
        },
      });
      const updated = await tx.business.updateMany({
        where: { id: access.businessId },
        data: { publishedWebsiteId: created.id },
      });
      if (updated.count !== 1) {
        throw new WebsitePublishError("Could not update the current published website.");
      }
      return created;
    });

  try {
    return await write();
  } catch (error) {
    if (key && uniqueConflict(error)) {
      const existing = await db.websitePublish.findFirst({
        where: { businessId: access.businessId, idempotencyKey: key },
      });
      if (existing) return existing;
    }
    if (uniqueConflict(error)) {
      return await write();
    }
    throw error;
  }
}

export async function rollbackWebsite(
  db: Db,
  access: BusinessAccess,
  input: { publishId: string; idempotencyKey?: string | null },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  await requireSaasOperatingEntitlement(db, access);

  const source = access.assertOwned(
    await db.websitePublish.findFirst({
      where: { id: input.publishId, ...access.scope },
    }),
  );
  const snapshot = parseWebsiteSnapshot(source.snapshotJson);
  const key = input.idempotencyKey?.trim() || null;
  if (key) {
    const existing = await db.websitePublish.findFirst({
      where: { businessId: access.businessId, idempotencyKey: key },
    });
    if (existing) return existing;
  }

  const write = async () =>
    db.$transaction(async (tx) => {
      if (key) {
        const raced = await tx.websitePublish.findFirst({
          where: { businessId: access.businessId, idempotencyKey: key },
        });
        if (raced) return raced;
      }
      const latest = await tx.websitePublish.findFirst({
        where: { businessId: access.businessId },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true },
      });
      const created = await tx.websitePublish.create({
        data: {
          businessId: access.businessId,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          schemaVersion: snapshot.schemaVersion,
          snapshotJson: source.snapshotJson,
          summary: `Rolled back to version ${source.versionNumber}`,
          publishedByMembershipId: access.workspace.membership.id,
          sourcePublishId: source.id,
          idempotencyKey: key,
        },
      });
      await tx.business.updateMany({
        where: { id: access.businessId },
        data: { publishedWebsiteId: created.id },
      });
      return created;
    });

  try {
    return await write();
  } catch (error) {
    if (key && uniqueConflict(error)) {
      const existing = await db.websitePublish.findFirst({
        where: { businessId: access.businessId, idempotencyKey: key },
      });
      if (existing) return existing;
    }
    if (uniqueConflict(error)) return await write();
    throw error;
  }
}

export async function websiteHasUnpublishedChanges(db: Db, access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  const current = await db.business.findFirst({
    where: { id: access.businessId },
    select: { publishedWebsiteId: true },
  });
  if (!current?.publishedWebsiteId) return true;
  const published = await db.websitePublish.findFirst({
    where: { id: current.publishedWebsiteId, businessId: access.businessId },
  });
  if (!published) return true;
  const draft = await buildWebsiteSnapshot(db, access);
  return serializeWebsiteSnapshot(parseWebsiteSnapshot(published.snapshotJson)) !==
    serializeWebsiteSnapshot(draft);
}

export async function listWebsitePublishes(db: Db, access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  const owned = await db.business.findFirst({
    where: { id: access.businessId },
    select: { id: true, publishedWebsiteId: true },
  });
  if (!owned || owned.id !== access.businessId) {
    throw new WebsitePublishError("Business workspace is required.");
  }
  const rows = await db.websitePublish.findMany({
    where: { businessId: access.businessId },
    orderBy: { versionNumber: "desc" },
    include: {
      publishedBy: { include: { user: { select: { name: true, email: true } } } },
    },
  });
  return {
    currentId: owned.publishedWebsiteId,
    versions: rows.map((row) => ({
      id: row.id,
      versionNumber: row.versionNumber,
      publishedAt: row.publishedAt,
      summary: row.summary,
      sourcePublishId: row.sourcePublishId,
      isCurrent: row.id === owned.publishedWebsiteId,
      publishedByName: row.publishedBy?.user.name ?? row.publishedBy?.user.email ?? null,
    })),
  };
}

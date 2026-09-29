/**
 * Atomic website publish / rollback / OWNER restore.
 *
 * Publish inserts an immutable WebsitePublish row, then moves
 * Business.publishedWebsiteId in the same transaction. Rollback copies
 * a prior payload into a new row. OWNER restore moves the current
 * pointer back to an existing row and restores captured
 * TenantIntakeSnapshot ids when that publish recorded them. WebsitePublish, TenantIntakeSnapshot, and
 * ServiceRequest rows are never rewritten. Already-open hire forms still
 * submit the snapshot id they displayed.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import { parseTenantIntakeSnapshotPayload } from "@/lib/intake-snapshot";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductCapability } from "@/lib/product-entitlements";
import { isConfiguredTrade } from "@/lib/trades";
import { buildWebsiteSnapshot, WebsitePublishError } from "@/lib/website-engine/builder";
import {
  parseWebsiteSnapshot,
  serializeWebsiteSnapshot,
  WEBSITE_PUBLISH_HISTORY_LIMIT,
  WEBSITE_PUBLISH_RESTORE_CONFIRM_REQUIRED,
  WEBSITE_PUBLISH_RESTORE_STALE,
  type PublishedWebsiteSnapshot,
} from "@/lib/website-engine/snapshot";
import { summarizeWebsiteSnapshotChange } from "@/lib/website-engine/summary";
import { validateWebsiteSnapshot } from "@/lib/website-engine/validate";

type Db = PrismaClient;

export { WebsitePublishError, WEBSITE_PUBLISH_HISTORY_LIMIT };

const PUBLISH_ID = /^[a-zA-Z0-9_-]+$/;

function uniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function requireOwner(access: BusinessAccess) {
  requireBusinessRole(access, "OWNER");
}

function readOwnedPublishId(value: unknown, message: string) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 128 || !PUBLISH_ID.test(id)) {
    throw new WebsitePublishError(message);
  }
  return id;
}

async function waitForPointerWriteHold(hold?: () => Promise<void>) {
  if (hold) await hold();
}

async function restoreCapturedIntakePointers(
  tx: Prisma.TransactionClient,
  access: BusinessAccess,
  snapshot: PublishedWebsiteSnapshot,
) {
  let restoredIntakeCount = 0;
  for (const trade of snapshot.trades) {
    if (trade.tenantIntakeCaptured !== true) continue;
    if (!isConfiguredTrade(trade.code)) {
      throw new WebsitePublishError(
        `Published trade ${trade.label || trade.code} cannot be restored.`,
      );
    }
    if (trade.tenantIntake == null) {
      const pointed = await tx.businessTrade.updateMany({
        where: { businessId: access.businessId, tradeCode: trade.code },
        data: { publishedIntakeSnapshotId: null },
      });
      if (pointed.count !== 1) {
        throw new WebsitePublishError(
          `Could not restore the captured intake snapshot for ${trade.label || trade.code}.`,
        );
      }
      restoredIntakeCount += 1;
      continue;
    }
    if (!trade.tenantIntake.snapshotId || trade.tenantIntake.versionNumber < 1) {
      throw new WebsitePublishError(
        `Published intake snapshot for ${trade.label || trade.code} is invalid.`,
      );
    }
    const row = await tx.tenantIntakeSnapshot.findFirst({
      where: {
        id: trade.tenantIntake.snapshotId,
        businessId: access.businessId,
        tradeCode: trade.code,
      },
    });
    if (!row || row.versionNumber !== trade.tenantIntake.versionNumber) {
      throw new WebsitePublishError(
        `The captured intake snapshot for ${trade.label || trade.code} is missing or unusable.`,
      );
    }
    const payload = parseTenantIntakeSnapshotPayload(row.snapshotJson);
    if (
      !payload ||
      payload.tradeCode !== trade.code ||
      payload.versionNumber !== row.versionNumber
    ) {
      throw new WebsitePublishError(
        `The captured intake snapshot for ${trade.label || trade.code} is missing or unusable.`,
      );
    }
    const pointed = await tx.businessTrade.updateMany({
      where: { businessId: access.businessId, tradeCode: trade.code },
      data: { publishedIntakeSnapshotId: row.id },
    });
    if (pointed.count !== 1) {
      throw new WebsitePublishError(
        `Could not restore the captured intake snapshot for ${trade.label || trade.code}.`,
      );
    }
    restoredIntakeCount += 1;
  }
  return restoredIntakeCount;
}

async function loadWebsitePublishHistoryRows(db: Db, access: BusinessAccess) {
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
    take: WEBSITE_PUBLISH_HISTORY_LIMIT,
    include: {
      publishedBy: { include: { user: { select: { name: true, email: true } } } },
    },
  });
  return {
    currentId: owned.publishedWebsiteId,
    historyLimit: WEBSITE_PUBLISH_HISTORY_LIMIT,
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

export async function publishWebsite(
  db: Db,
  access: BusinessAccess,
  input: { idempotencyKey?: string | null; beforePointerWrite?: () => Promise<void> } = {},
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.WEBSITE_BUILDER);

  const key = input.idempotencyKey?.trim() || null;
  if (key) {
    const existing = await db.websitePublish.findFirst({
      where: { businessId: access.businessId, idempotencyKey: key },
    });
    if (existing) {
      access.assertOwned(existing);
      return existing;
    }
  }

  const snapshot = await buildWebsiteSnapshot(db, access);
  const validated = validateWebsiteSnapshot(snapshot);
  if (!validated.ok) {
    throw new WebsitePublishError(validated.errors[0] ?? "Website snapshot is invalid.");
  }

  const current = await db.business.findFirst({
    where: { id: access.businessId },
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
      await waitForPointerWriteHold(input.beforePointerWrite);
      const updated = await tx.business.updateMany({
        where: { id: access.businessId },
        data: { publishedWebsiteId: created.id },
      });
      if (updated.count !== 1) {
        throw new WebsitePublishError("Could not update the current published website.");
      }
      return created;
    }, { timeout: 15000 });

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
  requireOwner(access);
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.WEBSITE_BUILDER);

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

/** Bounded read-only history for OWNER and ADMIN. Restore stays OWNER-only. */
export async function listWebsitePublishes(db: Db, access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  return loadWebsitePublishHistoryRows(db, access);
}

/**
 * OWNER restore history. ADMIN with MANAGE_SETTINGS can still read the
 * same bounded list through listWebsitePublishes. Restore stays OWNER-only.
 */
export async function listOwnedWebsitePublishHistory(db: Db, access: BusinessAccess) {
  requireOwner(access);
  return loadWebsitePublishHistoryRows(db, access);
}

/**
 * Move Business.publishedWebsiteId to an older owned WebsitePublish row
 * and restore each captured TenantIntakeSnapshot pointer. Trades that
 * were not captured at publish are skipped.
 * Never updates WebsitePublish, TenantIntakeSnapshot, or ServiceRequest
 * rows. expectedCurrentId is the optimistic lock: a later publish or
 * restore makes this attempt stale.
 */
export async function restoreOwnedWebsitePublish(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    publishId: string;
    confirmed: boolean;
    expectedCurrentId: string;
    beforePointerWrite?: () => Promise<void>;
  },
) {
  requireOwner(access);
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.WEBSITE_BUILDER);
  if (input.confirmed !== true) {
    throw new WebsitePublishError(WEBSITE_PUBLISH_RESTORE_CONFIRM_REQUIRED);
  }
  const publishId = readOwnedPublishId(input.publishId, "Choose a published website version to restore.");
  const expectedCurrentId = readOwnedPublishId(
    input.expectedCurrentId,
    WEBSITE_PUBLISH_RESTORE_STALE,
  );

  return db.$transaction(async (tx) => {
    const source = access.assertOwned(
      await tx.websitePublish.findFirst({
        where: { id: publishId, ...access.scope },
      }),
    );
    const snapshot = parseWebsiteSnapshot(source.snapshotJson);
    const validated = validateWebsiteSnapshot(snapshot);
    if (!validated.ok) {
      throw new WebsitePublishError(validated.errors[0] ?? "That published website cannot be restored.");
    }
    await waitForPointerWriteHold(input.beforePointerWrite);
    const restoredIntakeCount = await restoreCapturedIntakePointers(
      tx,
      access,
      validated.snapshot,
    );
    const updated = await tx.business.updateMany({
      where: { id: access.businessId, publishedWebsiteId: expectedCurrentId },
      data: { publishedWebsiteId: source.id },
    });
    if (updated.count !== 1) {
      throw new WebsitePublishError(WEBSITE_PUBLISH_RESTORE_STALE);
    }
    return { ...source, restoredIntakeCount };
  }, { timeout: 15000 });
}

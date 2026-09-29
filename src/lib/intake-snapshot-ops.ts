/**
 * OWNER persistence for immutable tenant intake snapshots.
 *
 * Tenant scope always comes from BusinessAccess. Browser-supplied
 * businessId is ignored. ADMIN/MEMBER cannot publish or restore. Drafts
 * never reach public hire forms. Restore moves BusinessTrade.publishedIntakeSnapshotId
 * only. A published website uses the exact snapshot IDs captured at
 * website publish, not this live pointer, until OWNER restores that
 * website version (which also moves these pointers to the captured ids).
 * Historical ServiceRequest rows keep the version they froze.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { requireBusinessRole } from "@/lib/authorization";
import { listActiveBusinessTrades } from "@/lib/business-trades";
import {
  INTAKE_CONDITION_PUBLISH_REVIEW_REQUIRED,
  INTAKE_CONDITION_RESTORE_CONFIRM_REQUIRED,
  IntakeConditionError,
  parseIntakeConditionDocument,
  validateIntakeConditionDocument,
  type IntakeConditionDocument,
  type IntakeConditionPublishedView,
  type IntakeConditionSnapshotHistoryView,
} from "@/lib/intake-conditionals";
import {
  PUBLIC_INTAKE_REFRESH_FORM,
  TENANT_INTAKE_SNAPSHOT_HISTORY_LIMIT,
  buildTenantIntakeSnapshotPayload,
  parseTenantIntakeSnapshotPayload,
  publishedOverlayFromRow,
  readReferencedTenantIntakeSnapshotId,
  serializeTenantIntakeSnapshotPayload,
  summarizeTenantIntakeSnapshot,
  type PublishedIntakeOverlay,
} from "@/lib/intake-snapshot";
import { currentIntakeSchema } from "@/lib/intake-schema";
import { isConfiguredTrade, tradeLabel, type TradeCode } from "@/lib/trades";

export { PUBLIC_INTAKE_REFRESH_FORM };

export type CurrentPublishedIntake =
  | { status: "none" }
  | { status: "ready"; overlay: PublishedIntakeOverlay }
  | { status: "unavailable" };

type PublicSnapshotDb = {
  businessTrade?: {
    findFirst?: (args: {
      where: { businessId: string; tradeCode: string };
      select: { publishedIntakeSnapshotId: true };
    }) => Promise<{ publishedIntakeSnapshotId: string | null } | null>;
  };
  tenantIntakeSnapshot?: {
    findFirst: (args: {
      where: { id: string; businessId: string; tradeCode: string };
      select: {
        id: true;
        versionNumber: true;
        snapshotJson: true;
        publishedAt: true;
      };
    }) => Promise<{
      id: string;
      versionNumber: number;
      snapshotJson: string;
      publishedAt: Date;
    } | null>;
  };
};

type Db = PrismaClient | Prisma.TransactionClient;

function uniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function requireOwner(access: BusinessAccess) {
  requireBusinessRole(access, "OWNER");
}

async function requireOwnedTrade(db: Db, access: BusinessAccess, tradeCode: string) {
  requireOwner(access);
  const code = isConfiguredTrade(tradeCode) ? tradeCode : "";
  if (!code) {
    throw new IntakeConditionError("Choose a configured trade for this snapshot.");
  }
  const trades = await listActiveBusinessTrades(db, access.businessId);
  const allowed = trades.some((row) => row.tradeCode === code);
  if (!allowed) {
    throw new IntakeConditionError(`${tradeLabel(code)} is not an active trade for this business.`);
  }
  return code;
}

export async function loadCurrentPublishedIntakeView(
  db: Db,
  access: BusinessAccess,
  tradeCode: TradeCode,
): Promise<IntakeConditionPublishedView> {
  requireOwner(access);
  const membership = await db.businessTrade.findFirst({
    where: { ...access.scope, tradeCode },
    select: { publishedIntakeSnapshotId: true },
  });
  if (!membership?.publishedIntakeSnapshotId) return null;
  const row = await db.tenantIntakeSnapshot.findFirst({
    where: {
      id: membership.publishedIntakeSnapshotId,
      ...access.scope,
      tradeCode,
    },
  });
  if (!row) return null;
  return {
    snapshotId: row.id,
    versionNumber: row.versionNumber,
    publishedAt: row.publishedAt.toISOString(),
    summary: row.summary,
  };
}

export async function loadOwnedTenantIntakeSnapshot(
  db: Db,
  access: BusinessAccess,
  input: { snapshotId: string; tradeCode?: string },
) {
  requireOwner(access);
  return access.assertOwned(
    await db.tenantIntakeSnapshot.findFirst({
      where: {
        id: input.snapshotId,
        ...access.scope,
        ...(input.tradeCode ? { tradeCode: input.tradeCode } : {}),
      },
    }),
  );
}

export async function listOwnedTenantIntakeSnapshotHistory(
  db: Db,
  access: BusinessAccess,
  tradeCode: string,
): Promise<IntakeConditionSnapshotHistoryView> {
  const code = await requireOwnedTrade(db, access, tradeCode);
  const membership = await db.businessTrade.findFirst({
    where: { ...access.scope, tradeCode: code },
    select: { publishedIntakeSnapshotId: true },
  });
  const currentSnapshotId = membership?.publishedIntakeSnapshotId ?? null;
  const rows = await db.tenantIntakeSnapshot.findMany({
    where: { ...access.scope, tradeCode: code },
    orderBy: { versionNumber: "desc" },
    take: TENANT_INTAKE_SNAPSHOT_HISTORY_LIMIT,
    select: {
      id: true,
      versionNumber: true,
      publishedAt: true,
      summary: true,
    },
  });
  return {
    currentSnapshotId,
    historyLimit: TENANT_INTAKE_SNAPSHOT_HISTORY_LIMIT,
    versions: rows.map((row) => ({
      snapshotId: row.id,
      versionNumber: row.versionNumber,
      publishedAt: row.publishedAt.toISOString(),
      summary: row.summary,
      isCurrent: row.id === currentSnapshotId,
    })),
  };
}

/**
 * Move BusinessTrade.publishedIntakeSnapshotId to an older owned snapshot.
 * Never updates TenantIntakeSnapshot rows. Historical ServiceRequest rows
 * keep the version they froze. Public forms still submit the snapshot id
 * they displayed.
 */
export async function restoreOwnedTenantIntakeSnapshot(
  db: PrismaClient,
  access: BusinessAccess,
  input: { snapshotId: string; tradeCode: string; confirmed: boolean },
) {
  const tradeCode = await requireOwnedTrade(db, access, input.tradeCode);
  if (input.confirmed !== true) {
    throw new IntakeConditionError(INTAKE_CONDITION_RESTORE_CONFIRM_REQUIRED);
  }
  const snapshotId = input.snapshotId.trim();
  if (!snapshotId || snapshotId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(snapshotId)) {
    throw new IntakeConditionError("Choose a published version to restore.");
  }

  return db.$transaction(async (tx) => {
    const row = access.assertOwned(
      await tx.tenantIntakeSnapshot.findFirst({
        where: { id: snapshotId, ...access.scope },
      }),
    );
    if (row.tradeCode !== tradeCode) {
      throw new IntakeConditionError("That published version belongs to a different trade.");
    }
    const payload = parseTenantIntakeSnapshotPayload(row.snapshotJson);
    if (
      !payload ||
      payload.tradeCode !== tradeCode ||
      payload.versionNumber !== row.versionNumber
    ) {
      throw new IntakeConditionError("That published version cannot be restored.");
    }
    const pointed = await tx.businessTrade.updateMany({
      where: { businessId: access.businessId, tradeCode },
      data: { publishedIntakeSnapshotId: row.id },
    });
    if (pointed.count !== 1) {
      throw new IntakeConditionError("Could not update the current published intake snapshot.");
    }
    return row;
  });
}

export async function createTenantIntakeSnapshot(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    tradeCode: string;
    document: IntakeConditionDocument;
    reviewed: boolean;
    idempotencyKey?: string | null;
  },
) {
  const tradeCode = await requireOwnedTrade(db, access, input.tradeCode);
  if (input.reviewed !== true) {
    throw new IntakeConditionError(INTAKE_CONDITION_PUBLISH_REVIEW_REQUIRED);
  }
  const schema = currentIntakeSchema(tradeCode);
  const validated = validateIntakeConditionDocument(input.document, schema, {
    allowPublished: true,
  });
  if (!validated.ok) {
    throw new IntakeConditionError(validated.errors[0] ?? "That draft could not be published.");
  }

  const key = input.idempotencyKey?.trim() || null;
  if (key) {
    const existing = await db.tenantIntakeSnapshot.findFirst({
      where: { businessId: access.businessId, tradeCode, idempotencyKey: key },
    });
    if (existing) {
      access.assertOwned(existing);
      return existing;
    }
  }

  const write = async () =>
    db.$transaction(async (tx) => {
      if (key) {
        const raced = await tx.tenantIntakeSnapshot.findFirst({
          where: { businessId: access.businessId, tradeCode, idempotencyKey: key },
        });
        if (raced) return raced;
      }
      const latest = await tx.tenantIntakeSnapshot.findFirst({
        where: { businessId: access.businessId, tradeCode },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true },
      });
      const versionNumber = (latest?.versionNumber ?? 0) + 1;
      const payload = buildTenantIntakeSnapshotPayload({
        schema,
        document: validated.document,
        versionNumber,
      });
      const created = await tx.tenantIntakeSnapshot.create({
        data: {
          businessId: access.businessId,
          tradeCode,
          versionNumber,
          status: "PUBLISHED",
          schemaVersion: payload.schemaVersion,
          snapshotJson: serializeTenantIntakeSnapshotPayload(payload),
          summary: summarizeTenantIntakeSnapshot(payload),
          publishedByMembershipId: access.workspace.membership.id,
          idempotencyKey: key,
        },
      });
      const pointed = await tx.businessTrade.updateMany({
        where: { businessId: access.businessId, tradeCode },
        data: { publishedIntakeSnapshotId: created.id },
      });
      if (pointed.count !== 1) {
        throw new IntakeConditionError("Could not update the current published intake snapshot.");
      }
      return created;
    });

  try {
    return await write();
  } catch (error) {
    if (key && uniqueConflict(error)) {
      const existing = await db.tenantIntakeSnapshot.findFirst({
        where: { businessId: access.businessId, tradeCode, idempotencyKey: key },
      });
      if (existing) return existing;
    }
    if (uniqueConflict(error)) {
      return await write();
    }
    throw error;
  }
}

export async function readCurrentPublishedIntake(
  db: PublicSnapshotDb,
  businessId: string,
  tradeCode: string,
): Promise<CurrentPublishedIntake> {
  if (!isConfiguredTrade(tradeCode) || !db.businessTrade?.findFirst) {
    return { status: "unavailable" };
  }
  const membership = await db.businessTrade.findFirst({
    where: { businessId, tradeCode },
    select: { publishedIntakeSnapshotId: true },
  });
  if (!membership?.publishedIntakeSnapshotId) return { status: "none" };
  if (!db.tenantIntakeSnapshot) return { status: "unavailable" };
  const row = await db.tenantIntakeSnapshot.findFirst({
    where: {
      id: membership.publishedIntakeSnapshotId,
      businessId,
      tradeCode,
    },
    select: { id: true, versionNumber: true, snapshotJson: true, publishedAt: true },
  });
  if (!row) return { status: "unavailable" };
  const overlay = publishedOverlayFromRow(row);
  if (!overlay || overlay.document.tradeCode !== tradeCode) return { status: "unavailable" };
  return { status: "ready", overlay };
}

export async function loadPublishedIntakeOverlay(
  db: PublicSnapshotDb,
  businessId: string,
  tradeCode: string,
): Promise<PublishedIntakeOverlay | null> {
  const current = await readCurrentPublishedIntake(db, businessId, tradeCode);
  return current.status === "ready" ? current.overlay : null;
}

export type WebsitePublishedIntakeRef = {
  captured: boolean;
  tenantIntake: { snapshotId: string; versionNumber: number } | null;
};

async function loadExactPublishedIntakeOverlay(
  db: PublicSnapshotDb,
  input: { businessId: string; tradeCode: string; snapshotId: string; versionNumber?: number },
): Promise<PublishedIntakeOverlay | null> {
  if (!input.snapshotId || !isConfiguredTrade(input.tradeCode) || !db.tenantIntakeSnapshot) {
    return null;
  }
  const row = await db.tenantIntakeSnapshot.findFirst({
    where: {
      id: input.snapshotId,
      businessId: input.businessId,
      tradeCode: input.tradeCode,
    },
    select: { id: true, versionNumber: true, snapshotJson: true, publishedAt: true },
  });
  if (!row) return null;
  if (input.versionNumber != null && input.versionNumber >= 1 && row.versionNumber !== input.versionNumber) {
    return null;
  }
  const overlay = publishedOverlayFromRow(row);
  if (!overlay || overlay.document.tradeCode !== input.tradeCode) return null;
  if (overlay.baseSchema.tradeCode !== input.tradeCode) return null;
  return overlay;
}

/**
 * Resolve the exact tenant snapshot a public form displayed.
 * Browser-supplied businessId is ignored — callers pass the slug-resolved
 * business and the server-resolved trade. A referenced id that is missing,
 * cross-tenant, wrong-trade, or invalid fails closed. Omitting an id while
 * the published website captured an overlay, or while a compatibility site
 * has a current pointer, fails with a refresh-form response instead of
 * saving against platform intake. Already-opened forms may still submit
 * the snapshot they displayed after a later website publish or restore.
 */
export async function resolveReferencedTenantIntakeSnapshot(
  db: PublicSnapshotDb,
  input: {
    businessId: string;
    tradeCode: string;
    snapshotId?: string | null;
    websiteIntake?: WebsitePublishedIntakeRef | null;
  },
): Promise<
  { ok: true; overlay: PublishedIntakeOverlay | null } | { ok: false; refresh?: boolean }
> {
  const referenced = readReferencedTenantIntakeSnapshotId(input.snapshotId);
  if (!referenced.provided) {
    if (input.websiteIntake?.captured) {
      if (input.websiteIntake.tenantIntake) return { ok: false, refresh: true };
      return { ok: true, overlay: null };
    }
    const current = await readCurrentPublishedIntake(db, input.businessId, input.tradeCode);
    if (current.status === "none") return { ok: true, overlay: null };
    return { ok: false, refresh: true };
  }
  if (!referenced.snapshotId || !isConfiguredTrade(input.tradeCode)) return { ok: false };
  const overlay = await loadExactPublishedIntakeOverlay(db, {
    businessId: input.businessId,
    tradeCode: input.tradeCode,
    snapshotId: referenced.snapshotId,
  });
  if (!overlay) return { ok: false };
  return { ok: true, overlay };
}

export async function loadPublishedIntakeOverlaysForWebsiteSnapshot(
  db: Db,
  businessId: string,
  trades: Array<{
    code: string;
    tenantIntake: { snapshotId: string; versionNumber: number } | null;
    tenantIntakeCaptured: boolean;
  }>,
): Promise<{ ok: true; overlays: Record<string, PublishedIntakeOverlay> } | { ok: false }> {
  const overlays: Record<string, PublishedIntakeOverlay> = {};
  const legacyCodes: string[] = [];
  for (const trade of trades) {
    if (!isConfiguredTrade(trade.code)) continue;
    if (trade.tenantIntakeCaptured !== true) {
      legacyCodes.push(trade.code);
      continue;
    }
    if (trade.tenantIntake == null) continue;
    if (!trade.tenantIntake.snapshotId || trade.tenantIntake.versionNumber < 1) {
      return { ok: false };
    }
    const overlay = await loadExactPublishedIntakeOverlay(db, {
      businessId,
      tradeCode: trade.code,
      snapshotId: trade.tenantIntake.snapshotId,
      versionNumber: trade.tenantIntake.versionNumber,
    });
    if (!overlay) return { ok: false };
    overlays[trade.code] = overlay;
  }
  if (legacyCodes.length > 0) {
    const legacy = await loadPublishedIntakeOverlaysByTrade(db, businessId, legacyCodes);
    if (!legacy.ok) return { ok: false };
    Object.assign(overlays, legacy.overlays);
  }
  return { ok: true, overlays };
}

export async function loadPublishedIntakeOverlaysByTrade(
  db: Db,
  businessId: string,
  tradeCodes: string[],
): Promise<{ ok: true; overlays: Record<string, PublishedIntakeOverlay> } | { ok: false }> {
  const codes = [...new Set(tradeCodes.filter(isConfiguredTrade))];
  if (codes.length === 0) return { ok: true, overlays: {} };
  const trades = await db.businessTrade.findMany({
    where: { businessId, tradeCode: { in: codes } },
    select: { tradeCode: true, publishedIntakeSnapshotId: true },
  });
  const wanted = trades.filter((row) => row.publishedIntakeSnapshotId);
  if (wanted.length === 0) return { ok: true, overlays: {} };
  const rows = await db.tenantIntakeSnapshot.findMany({
    where: {
      businessId,
      id: { in: wanted.map((row) => row.publishedIntakeSnapshotId as string) },
    },
    select: {
      id: true,
      tradeCode: true,
      versionNumber: true,
      snapshotJson: true,
      publishedAt: true,
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const overlays: Record<string, PublishedIntakeOverlay> = {};
  for (const trade of wanted) {
    const row = trade.publishedIntakeSnapshotId
      ? byId.get(trade.publishedIntakeSnapshotId)
      : null;
    if (!row || row.tradeCode !== trade.tradeCode) return { ok: false };
    const overlay = publishedOverlayFromRow(row);
    if (!overlay) return { ok: false };
    overlays[trade.tradeCode] = overlay;
  }
  return { ok: true, overlays };
}

export function snapshotPayloadOrNull(snapshotJson: string) {
  return parseTenantIntakeSnapshotPayload(snapshotJson);
}

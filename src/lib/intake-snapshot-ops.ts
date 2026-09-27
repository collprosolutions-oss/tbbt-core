/**
 * OWNER persistence for immutable tenant intake snapshots.
 *
 * Tenant scope always comes from BusinessAccess. Browser-supplied
 * businessId is ignored. ADMIN/MEMBER cannot publish. Public hire forms
 * read only the current BusinessTrade pointer, never drafts.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { requireBusinessRole } from "@/lib/authorization";
import { listActiveBusinessTrades } from "@/lib/business-trades";
import {
  INTAKE_CONDITION_PUBLISH_REVIEW_REQUIRED,
  IntakeConditionError,
  parseIntakeConditionDocument,
  validateIntakeConditionDocument,
  type IntakeConditionDocument,
  type IntakeConditionPublishedView,
} from "@/lib/intake-conditionals";
import {
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

export async function loadPublishedIntakeOverlay(
  db: {
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
  },
  businessId: string,
  tradeCode: string,
): Promise<PublishedIntakeOverlay | null> {
  if (!isConfiguredTrade(tradeCode)) return null;
  if (!db.businessTrade?.findFirst || !db.tenantIntakeSnapshot) return null;
  try {
    const membership = await db.businessTrade.findFirst({
      where: { businessId, tradeCode },
      select: { publishedIntakeSnapshotId: true },
    });
    if (!membership?.publishedIntakeSnapshotId) return null;
    const row = await db.tenantIntakeSnapshot.findFirst({
      where: {
        id: membership.publishedIntakeSnapshotId,
        businessId,
        tradeCode,
      },
      select: { id: true, versionNumber: true, snapshotJson: true, publishedAt: true },
    });
    if (!row) return null;
    return publishedOverlayFromRow(row);
  } catch {
    return null;
  }
}

type PublicSnapshotDb = {
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

/**
 * Resolve the exact tenant snapshot a public form displayed.
 * Browser-supplied businessId is ignored — callers pass the slug-resolved
 * business and the server-resolved trade. A referenced id that is missing,
 * cross-tenant, wrong-trade, or invalid fails closed. Omitting an id does
 * not silently follow a newer current pointer.
 */
export async function resolveReferencedTenantIntakeSnapshot(
  db: PublicSnapshotDb,
  input: { businessId: string; tradeCode: string; snapshotId?: string | null },
): Promise<{ ok: true; overlay: PublishedIntakeOverlay | null } | { ok: false }> {
  const referenced = readReferencedTenantIntakeSnapshotId(input.snapshotId);
  if (!referenced.provided) return { ok: true, overlay: null };
  if (!referenced.snapshotId || !isConfiguredTrade(input.tradeCode)) return { ok: false };
  if (!db.tenantIntakeSnapshot) return { ok: false };
  const row = await db.tenantIntakeSnapshot.findFirst({
    where: {
      id: referenced.snapshotId,
      businessId: input.businessId,
      tradeCode: input.tradeCode,
    },
    select: { id: true, versionNumber: true, snapshotJson: true, publishedAt: true },
  });
  if (!row) return { ok: false };
  const overlay = publishedOverlayFromRow(row);
  if (!overlay || overlay.document.tradeCode !== input.tradeCode) return { ok: false };
  if (overlay.baseSchema.tradeCode !== input.tradeCode) return { ok: false };
  return { ok: true, overlay };
}

export async function loadPublishedIntakeOverlaysByTrade(
  db: Db,
  businessId: string,
  tradeCodes: string[],
): Promise<Record<string, PublishedIntakeOverlay>> {
  const codes = [...new Set(tradeCodes.filter(isConfiguredTrade))];
  if (codes.length === 0) return {};
  const trades = await db.businessTrade.findMany({
    where: { businessId, tradeCode: { in: codes } },
    select: { tradeCode: true, publishedIntakeSnapshotId: true },
  });
  const wanted = trades.filter((row) => row.publishedIntakeSnapshotId);
  if (wanted.length === 0) return {};
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
    if (!row || row.tradeCode !== trade.tradeCode) continue;
    const overlay = publishedOverlayFromRow(row);
    if (overlay) overlays[trade.tradeCode] = overlay;
  }
  return overlays;
}

export function snapshotPayloadOrNull(snapshotJson: string) {
  return parseTenantIntakeSnapshotPayload(snapshotJson);
}

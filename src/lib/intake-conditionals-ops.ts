/**
 * OWNER persistence for intake-condition drafts.
 *
 * Tenant scope always comes from BusinessAccess. Browser-supplied
 * businessId is ignored. ADMIN/MEMBER cannot draft. Public hire forms
 * never read these draft rows — only published TenantIntakeSnapshot rows.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { requireBusinessRole } from "@/lib/authorization";
import { listActiveBusinessTrades } from "@/lib/business-trades";
import {
  INTAKE_CONDITION_PUBLISH_DESCRIPTION,
  INTAKE_CONDITION_PUBLISH_REVIEW_REQUIRED,
  INTAKE_CONDITION_STATUS_DRAFT,
  IntakeConditionError,
  assertDraftOnlyStatus,
  emptyIntakeConditionDocument,
  parseIntakeConditionDocument,
  serializeIntakeConditionDocument,
  validateIntakeConditionDocument,
  type IntakeConditionDocument,
  type IntakeConditionWorkspaceView,
} from "@/lib/intake-conditionals";
import {
  createTenantIntakeSnapshot,
  loadCurrentPublishedIntakeView,
} from "@/lib/intake-snapshot-ops";
import { currentIntakeSchema, publicIntakeSchemaProjection } from "@/lib/intake-schema";
import { DEFAULT_TRADE, isConfiguredTrade, tradeLabel, type TradeCode } from "@/lib/trades";

type Db = PrismaClient | Prisma.TransactionClient;

function requireOwner(access: BusinessAccess) {
  requireBusinessRole(access, "OWNER");
}

async function requireOwnedTrade(db: Db, access: BusinessAccess, tradeCode: string) {
  requireOwner(access);
  const code = isConfiguredTrade(tradeCode) ? tradeCode : "";
  if (!code) {
    throw new IntakeConditionError("Choose a configured trade for this draft.");
  }
  const trades = await listActiveBusinessTrades(db, access.businessId);
  const allowed = trades.some((row) => row.tradeCode === code);
  if (!allowed) {
    throw new IntakeConditionError(
      `${tradeLabel(code)} is not an active trade for this business.`,
    );
  }
  return code;
}

export async function loadIntakeConditionWorkspace(
  db: Db,
  access: BusinessAccess,
  requestedTrade?: string | null,
): Promise<IntakeConditionWorkspaceView> {
  requireOwner(access);
  const trades = await listActiveBusinessTrades(db, access.businessId);
  const codes = trades.map((row) => row.tradeCode);
  const selected: TradeCode =
    requestedTrade && isConfiguredTrade(requestedTrade) && codes.includes(requestedTrade)
      ? requestedTrade
      : (codes[0] ?? DEFAULT_TRADE);
  const schema = currentIntakeSchema(selected);
  const row = await db.intakeConditionDraft.findFirst({
    where: { ...access.scope, tradeCode: selected },
  });
  const parsed = row ? parseIntakeConditionDocument(row.documentJson) : null;
  const document =
    parsed?.ok === true
      ? parsed.document
      : emptyIntakeConditionDocument(selected, schema);
  return {
    selectedTrade: selected,
    trades: codes.map((code) => ({ code, label: tradeLabel(code) })),
    baseSchema: publicIntakeSchemaProjection(schema),
    document: {
      ...document,
      tradeCode: selected,
      baseSchemaKey: schema.key,
      baseSchemaVersion: schema.version,
      status: INTAKE_CONDITION_STATUS_DRAFT,
    },
    savedAt: row?.updatedAt.toISOString() ?? null,
    status: INTAKE_CONDITION_STATUS_DRAFT,
    published: await loadCurrentPublishedIntakeView(db, access, selected),
    publishNextRequirement: INTAKE_CONDITION_PUBLISH_DESCRIPTION,
    publishReviewRequired: INTAKE_CONDITION_PUBLISH_REVIEW_REQUIRED,
  };
}

export async function saveIntakeConditionDraft(
  db: Db,
  access: BusinessAccess,
  input: { tradeCode: string; document: unknown },
) {
  const tradeCode = await requireOwnedTrade(db, access, input.tradeCode);
  const schema = currentIntakeSchema(tradeCode);
  const validated = validateIntakeConditionDocument(input.document, schema);
  if (!validated.ok) {
    throw new IntakeConditionError(validated.errors[0] ?? "That draft could not be validated.");
  }
  assertDraftOnlyStatus(validated.document.status);
  const document: IntakeConditionDocument = {
    ...validated.document,
    tradeCode,
    baseSchemaKey: schema.key,
    baseSchemaVersion: schema.version,
    status: INTAKE_CONDITION_STATUS_DRAFT,
  };
  const documentJson = serializeIntakeConditionDocument(document);
  const existing = await db.intakeConditionDraft.findFirst({
    where: { ...access.scope, tradeCode },
  });
  if (existing) {
    access.assertOwned(existing);
    return db.intakeConditionDraft.update({
      where: { id: existing.id },
      data: {
        baseSchemaKey: schema.key,
        baseSchemaVersion: schema.version,
        status: INTAKE_CONDITION_STATUS_DRAFT,
        documentJson,
        updatedByMembershipId: access.workspace.membership.id,
      },
    });
  }
  return db.intakeConditionDraft.create({
    data: {
      businessId: access.businessId,
      tradeCode,
      baseSchemaKey: schema.key,
      baseSchemaVersion: schema.version,
      status: INTAKE_CONDITION_STATUS_DRAFT,
      documentJson,
      updatedByMembershipId: access.workspace.membership.id,
    },
  });
}

export async function validateOwnedIntakeConditionDraft(
  db: Db,
  access: BusinessAccess,
  input: { tradeCode: string; document: unknown },
) {
  const tradeCode = await requireOwnedTrade(db, access, input.tradeCode);
  const schema = currentIntakeSchema(tradeCode);
  const validated = validateIntakeConditionDocument(input.document, schema);
  if (!validated.ok) {
    throw new IntakeConditionError(validated.errors[0] ?? "That draft could not be validated.");
  }
  return validated.document;
}

export async function loadOwnedIntakeConditionDraft(
  db: Db,
  access: BusinessAccess,
  input: { tradeCode: string; draftId?: string },
) {
  const tradeCode = await requireOwnedTrade(db, access, input.tradeCode);
  const row = access.assertOwned(
    await db.intakeConditionDraft.findFirst({
      where: input.draftId
        ? { id: input.draftId, ...access.scope, tradeCode }
        : { ...access.scope, tradeCode },
    }),
  );
  return row;
}

export async function publishIntakeConditionDraft(
  db: PrismaClient,
  access: BusinessAccess,
  input: { tradeCode: string; reviewed?: boolean; idempotencyKey?: string | null },
) {
  const tradeCode = await requireOwnedTrade(db, access, input.tradeCode);
  const draft = access.assertOwned(
    await db.intakeConditionDraft.findFirst({
      where: { ...access.scope, tradeCode },
    }),
  );
  const parsed = parseIntakeConditionDocument(draft.documentJson);
  if (!parsed.ok) {
    throw new IntakeConditionError(parsed.errors[0] ?? "That draft could not be published.");
  }
  return createTenantIntakeSnapshot(db, access, {
    tradeCode,
    document: parsed.document,
    reviewed: input.reviewed === true,
    idempotencyKey: input.idempotencyKey,
  });
}

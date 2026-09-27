/**
 * Read projection for durable Controlled AI Action provenance.
 *
 * Shows only real ControlledAiActionAttempt rows. Never infers origin from
 * BusinessActionItem, BsosRecommendationState, titles, timestamps, or
 * history JSON. Preview and Action Center reads do not write here.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import {
  ACTION_CENTER_HISTORY_PATH,
  actionCenterHref,
  resolveOwnedActionTargetLink,
  type OwnedActionTargetLink,
} from "@/lib/chief-of-staff/action-center";
import {
  CONTROLLED_AI_ATTEMPT_RESULTS,
  getControlledActionEntry,
  type ControlledActionKey,
  type ControlledAiAttemptResult,
} from "@/lib/chief-of-staff/controlled-actions";
import { formatDateTime } from "@/lib/format";

type Db = PrismaClient | Prisma.TransactionClient;

export const CONTROLLED_AI_HISTORY_LIMIT = 50;

export type ControlledAiHistoryRow = {
  id: string;
  actionKey: ControlledActionKey;
  displayLabel: string;
  result: ControlledAiAttemptResult;
  resultCode: string;
  resultMessage: string;
  recommendationKey: string | null;
  recommendationLabel: string | null;
  confirmedAt: string;
  confirmedAtLabel: string;
  executedAt: string | null;
  executedAtLabel: string | null;
  confirmedByName: string | null;
  targetHref: string | null;
  targetLabel: string | null;
};

export type ControlledAiActionHistory = {
  timeZone: string;
  href: string;
  attempts: ControlledAiHistoryRow[];
};

function authorizeHistoryRead(access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
}

function asAttemptResult(value: string): ControlledAiAttemptResult {
  return (CONTROLLED_AI_ATTEMPT_RESULTS as readonly string[]).includes(value)
    ? (value as ControlledAiAttemptResult)
    : "FAILED";
}

async function historyTargetLink(
  db: Db,
  access: BusinessAccess,
  row: {
    recommendationKey: string | null;
    targetRecordType: string | null;
    targetRecordId: string | null;
  },
): Promise<OwnedActionTargetLink | null> {
  if (row.recommendationKey) {
    const recommendation = await resolveOwnedActionTargetLink(db, access, {
      type: "RECOMMENDATION",
      id: row.recommendationKey,
    });
    if (recommendation) return recommendation;
  }
  if (row.targetRecordType === "BusinessActionItem" && row.targetRecordId) {
    const item = await db.businessActionItem.findFirst({
      where: { id: row.targetRecordId, businessId: access.businessId },
      select: { id: true, title: true },
    });
    if (!item) return null;
    return {
      href: actionCenterHref(item.id),
      label: item.title,
      recordType: "RECOMMENDATION",
    };
  }
  if (row.targetRecordType === "BsosRecommendationState" && row.targetRecordId) {
    const state = await db.bsosRecommendationState.findFirst({
      where: { id: row.targetRecordId, businessId: access.businessId },
      select: { id: true, recommendationKey: true },
    });
    if (!state) return null;
    return resolveOwnedActionTargetLink(db, access, {
      type: "RECOMMENDATION",
      id: state.recommendationKey,
    });
  }
  return null;
}

function historyRow(
  row: {
    id: string;
    actionKey: string;
    result: string;
    resultCode: string;
    resultMessage: string;
    recommendationKey: string | null;
    confirmedAt: Date;
    executedAt: Date | null;
    confirmedBy: { user: { name: string } } | null;
  },
  timeZone: string,
  target: OwnedActionTargetLink | null,
): ControlledAiHistoryRow {
  const entry = getControlledActionEntry(row.actionKey);
  return {
    id: row.id,
    actionKey: (entry?.key ?? row.actionKey) as ControlledActionKey,
    displayLabel: entry?.displayLabel ?? row.actionKey,
    result: asAttemptResult(row.result),
    resultCode: row.resultCode,
    resultMessage: row.resultMessage,
    recommendationKey: row.recommendationKey,
    recommendationLabel: target?.label ?? row.recommendationKey,
    confirmedAt: row.confirmedAt.toISOString(),
    confirmedAtLabel: formatDateTime(row.confirmedAt, timeZone),
    executedAt: row.executedAt ? row.executedAt.toISOString() : null,
    executedAtLabel: row.executedAt ? formatDateTime(row.executedAt, timeZone) : null,
    confirmedByName: row.confirmedBy?.user.name?.trim() || null,
    targetHref: target?.href ?? null,
    targetLabel: target?.label ?? null,
  };
}

export async function loadControlledAiActionHistory(
  db: Db,
  access: BusinessAccess,
  options?: { limit?: number },
): Promise<ControlledAiActionHistory> {
  authorizeHistoryRead(access);
  const limit = Math.min(Math.max(options?.limit ?? CONTROLLED_AI_HISTORY_LIMIT, 1), CONTROLLED_AI_HISTORY_LIMIT);
  const [business, attempts] = await Promise.all([
    db.business.findUnique({
      where: { id: access.businessId },
      select: { timezone: true },
    }),
    db.controlledAiActionAttempt.findMany({
      where: { businessId: access.businessId },
      orderBy: { confirmedAt: "desc" },
      take: limit,
      include: {
        confirmedBy: {
          select: { user: { select: { name: true } } },
        },
      },
    }),
  ]);
  const timeZone = resolveBusinessTimeZone(business);
  const rows: ControlledAiHistoryRow[] = [];
  for (const attempt of attempts) {
    const target = await historyTargetLink(db, access, attempt);
    rows.push(historyRow(attempt, timeZone, target));
  }
  return {
    timeZone,
    href: ACTION_CENTER_HISTORY_PATH,
    attempts: rows,
  };
}

export async function loadControlledAiActionAttempt(
  db: Db,
  access: BusinessAccess,
  rawId: string,
): Promise<ControlledAiHistoryRow | null> {
  authorizeHistoryRead(access);
  const id = rawId.trim();
  if (!id) return null;
  const [business, attempt] = await Promise.all([
    db.business.findUnique({
      where: { id: access.businessId },
      select: { timezone: true },
    }),
    db.controlledAiActionAttempt.findFirst({
      where: { id, businessId: access.businessId },
      include: {
        confirmedBy: {
          select: { user: { select: { name: true } } },
        },
      },
    }),
  ]);
  if (!attempt) return null;
  const timeZone = resolveBusinessTimeZone(business);
  const target = await historyTargetLink(db, access, attempt);
  return historyRow(attempt, timeZone, target);
}

/**
 * Owner Action Center — read projection over Controlled AI Actions V1.
 *
 * Live propose/confirm uses the current allowlist. Persisted
 * BusinessActionItem and BsosRecommendationState rows are useful
 * owner-plan truth, but they do not record whether a Controlled AI Action
 * produced them. This module never infers a historical ControlledActionKey
 * from generic BSOS state. Durable provenance lives on
 * ControlledAiActionAttempt and is loaded separately.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, roleHasCapability } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import {
  CONTROLLED_ACTION_CATALOG,
  type ControlledActionKey,
  getControlledActionEntry,
} from "@/lib/chief-of-staff/controlled-actions";
import { loadCanonicalRecommendationCatalog } from "@/lib/chief-of-staff/recommendations";
import type { ApprovalClass } from "@/lib/chief-of-staff/types";
import { formatDateTime } from "@/lib/format";

type Db = PrismaClient | Prisma.TransactionClient;

export const ACTION_CENTER_PATH = "/actions";
export const ACTION_CENTER_HISTORY_PATH = "/actions/history";
export const ACTION_CENTER_ORIGIN_NOT_RECORDED = "NOT_RECORDED" as const;
export type ActionCenterRecordedOrigin = typeof ACTION_CENTER_ORIGIN_NOT_RECORDED;
export const ACTION_CENTER_RECORD_KINDS = ["ACTION_ITEM", "RECOMMENDATION_STATE"] as const;
export type ActionCenterRecordKind = (typeof ACTION_CENTER_RECORD_KINDS)[number];

export const ACTION_CENTER_TARGET_RECORD_TYPES = [
  "CUSTOMER",
  "JOB",
  "ESTIMATE",
  "INVOICE",
  "REQUEST",
  "RECOMMENDATION",
] as const;
export type ActionCenterTargetRecordType = (typeof ACTION_CENTER_TARGET_RECORD_TYPES)[number];

export function canViewControlledActionCenter(access: { workspace?: { role?: string } }) {
  const role = access.workspace?.role;
  if (role !== "OWNER" && role !== "ADMIN" && role !== "MEMBER") return false;
  return roleHasCapability(role, CAPABILITIES.VIEW_REPORTS);
}

export function actionCenterHref(id: string) {
  return `${ACTION_CENTER_PATH}/${encodeURIComponent(id)}`;
}

function authorizeRead(access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
}

function safeInternalHref(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("://") || value.includes("\\") || value.includes("\n")) return null;
  return value;
}

const RECORD_HREF = /^\/(customers|jobs|estimates|invoices|requests)\/([^/?#]+)$/;

export type OwnedActionTargetLink = {
  href: string;
  label: string;
  recordType: ActionCenterTargetRecordType;
};

export async function resolveOwnedActionTargetLink(
  db: Db,
  access: BusinessAccess,
  target: { type: string; id: string },
): Promise<OwnedActionTargetLink | null> {
  authorizeRead(access);
  const id = target.id.trim();
  if (!id) return null;
  const type = target.type.trim().toUpperCase();

  if (type === "CUSTOMER") {
    const row = await db.customer.findFirst({
      where: { id, businessId: access.businessId },
      select: { id: true, name: true },
    });
    return row ? { href: `/customers/${row.id}`, label: row.name, recordType: "CUSTOMER" } : null;
  }
  if (type === "JOB") {
    const row = await db.job.findFirst({
      where: { id, businessId: access.businessId },
      select: { id: true },
    });
    return row ? { href: `/jobs/${row.id}`, label: "Job", recordType: "JOB" } : null;
  }
  if (type === "ESTIMATE") {
    const row = await db.estimate.findFirst({
      where: { id, businessId: access.businessId },
      select: { id: true },
    });
    return row ? { href: `/estimates/${row.id}`, label: "Estimate", recordType: "ESTIMATE" } : null;
  }
  if (type === "INVOICE") {
    const row = await db.invoice.findFirst({
      where: { id, businessId: access.businessId },
      select: { id: true },
    });
    return row ? { href: `/invoices/${row.id}`, label: "Invoice", recordType: "INVOICE" } : null;
  }
  if (type === "REQUEST") {
    const row = await db.serviceRequest.findFirst({
      where: { id, businessId: access.businessId },
      select: { id: true },
    });
    return row ? { href: `/requests/${row.id}`, label: "Request", recordType: "REQUEST" } : null;
  }
  if (type === "RECOMMENDATION") {
    return resolveOwnedRecommendationTarget(db, access, id);
  }
  return null;
}

async function resolveOwnedRecommendationTarget(
  db: Db,
  access: BusinessAccess,
  recommendationKey: string,
  known?: {
    titles: Map<string, string>;
    ownedKeys: Set<string>;
  },
): Promise<OwnedActionTargetLink | null> {
  if (known) {
    if (!known.ownedKeys.has(recommendationKey)) return null;
    return {
      href: actionCenterHref(recommendationKey),
      label: known.titles.get(recommendationKey) ?? recommendationKey,
      recordType: "RECOMMENDATION",
    };
  }
  const [state, actionItem, catalog] = await Promise.all([
    db.bsosRecommendationState.findFirst({
      where: { businessId: access.businessId, recommendationKey },
      select: { recommendationKey: true },
    }),
    db.businessActionItem.findFirst({
      where: { businessId: access.businessId, recommendationKey },
      select: { recommendationKey: true },
    }),
    loadCanonicalRecommendationCatalog(db, access.businessId),
  ]);
  const recommendation = catalog.recommendations.find((item) => item.key === recommendationKey);
  if (!state && !actionItem && !recommendation) return null;
  return {
    href: actionCenterHref(recommendationKey),
    label: recommendation?.title ?? recommendationKey,
    recordType: "RECOMMENDATION",
  };
}

async function relatedAreaHref(
  db: Db,
  access: BusinessAccess,
  rawHref: string | null | undefined,
): Promise<string | null> {
  const href = safeInternalHref(rawHref);
  if (!href) return null;
  const match = href.match(RECORD_HREF);
  if (!match) return href;
  const [, segment, recordId] = match;
  const type =
    segment === "customers"
      ? "CUSTOMER"
      : segment === "jobs"
        ? "JOB"
        : segment === "estimates"
          ? "ESTIMATE"
          : segment === "invoices"
            ? "INVOICE"
            : "REQUEST";
  const owned = await resolveOwnedActionTargetLink(db, access, { type, id: recordId });
  return owned?.href ?? null;
}

type HistoryEntry = {
  at: string;
  atLabel: string;
  status: string;
};

function readRecordedHistory(raw: unknown, timeZone: string): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const status = typeof record.status === "string" ? record.status : null;
    const at = typeof record.at === "string" ? record.at : null;
    if (!status || !at) return [];
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return [];
    return [{ at, atLabel: formatDateTime(date, timeZone), status }];
  });
}

function availableActionKeys(input: {
  active: boolean;
  status: string | null;
  hasActionItem: boolean;
}): ControlledActionKey[] {
  if (!input.active) return [];
  const keys: ControlledActionKey[] = [];
  if (input.status === "DISMISSED" || input.status === "COMPLETED") return keys;
  if (!input.hasActionItem) keys.push("CREATE_RECOMMENDATION_ACTION_ITEM");
  keys.push("DISMISS_RECOMMENDATION", "COMPLETE_RECOMMENDATION");
  return keys;
}

function catalogSummary(key: ControlledActionKey) {
  const entry = getControlledActionEntry(key);
  return {
    actionKey: key,
    displayLabel: entry?.displayLabel ?? key,
    purpose: entry?.purpose ?? "",
    approvalClass: (entry?.approvalClass ?? "OWNER_CONFIRMED_RECORD") as ApprovalClass,
    targetEntityType: entry?.targetEntityType ?? "RECOMMENDATION",
  };
}

export type ActionCenterAvailableAction = {
  actionKey: ControlledActionKey;
  displayLabel: string;
  purpose: string;
  approvalClass: ApprovalClass;
};

export type ActionCenterLiveTarget = {
  id: string;
  targetEntityType: "RECOMMENDATION";
  targetEntityId: string;
  targetLabel: string;
  targetHref: string | null;
  relatedAreaHref: string | null;
  why: string | null;
  recordedStatus: string | null;
  availableActions: ActionCenterAvailableAction[];
};

export type ActionCenterRecordedState = {
  id: string;
  recordKind: ActionCenterRecordKind;
  origin: ActionCenterRecordedOrigin;
  targetEntityType: "RECOMMENDATION";
  targetEntityId: string;
  targetLabel: string;
  targetHref: string | null;
  relatedAreaHref: string | null;
  why: string | null;
  recordedStatus: string;
  recordedAt: string;
  recordedAtLabel: string;
  actionItemId: string | null;
  actionItemStatus: string | null;
  history: HistoryEntry[];
};

export type ControlledActionCenter = {
  timeZone: string;
  catalog: ActionCenterAvailableAction[];
  needsOwnerConfirmation: ActionCenterLiveTarget[];
  recordedOwnerPlanState: ActionCenterRecordedState[];
};

export type ControlledActionCenterDetail = {
  id: string;
  live: ActionCenterLiveTarget | null;
  recordedOwnerPlanState: ActionCenterRecordedState[];
};

export function recordedOwnerPlanStateClaimsControlledAction(
  row: ActionCenterRecordedState & { actionKey?: unknown },
) {
  return row.origin !== ACTION_CENTER_ORIGIN_NOT_RECORDED || row.actionKey != null;
}

export async function loadControlledActionCenter(
  db: Db,
  access: BusinessAccess,
): Promise<ControlledActionCenter> {
  authorizeRead(access);
  const [catalog, states, actionItems, business] = await Promise.all([
    loadCanonicalRecommendationCatalog(db, access.businessId),
    db.bsosRecommendationState.findMany({
      where: { businessId: access.businessId },
      orderBy: { updatedAt: "desc" },
    }),
    db.businessActionItem.findMany({
      where: { businessId: access.businessId },
      orderBy: { updatedAt: "desc" },
    }),
    db.business.findUnique({
      where: { id: access.businessId },
      select: { timezone: true },
    }),
  ]);
  const timeZone = resolveBusinessTimeZone(business);
  const recommendationByKey = new Map(catalog.recommendations.map((item) => [item.key, item]));
  const stateByKey = new Map(states.map((row) => [row.recommendationKey, row]));
  const itemsByKey = new Map<string, (typeof actionItems)[number]>();
  for (const item of actionItems) {
    if (!itemsByKey.has(item.recommendationKey)) itemsByKey.set(item.recommendationKey, item);
  }
  const ownedRecommendationKeys = new Set<string>([
    ...catalog.recommendations.map((item) => item.key),
    ...states.map((row) => row.recommendationKey),
    ...actionItems.map((item) => item.recommendationKey),
  ]);
  const recommendationTitles = new Map<string, string>(
    catalog.recommendations.map((item) => [item.key, item.title]),
  );
  const knownTargets = { titles: recommendationTitles, ownedKeys: ownedRecommendationKeys };

  const needsOwnerConfirmation: ActionCenterLiveTarget[] = [];
  for (const recommendation of catalog.activeRecommendations) {
    const state = stateByKey.get(recommendation.key);
    const actionItem = itemsByKey.get(recommendation.key);
    const keys = availableActionKeys({
      active: true,
      status: state?.status ?? null,
      hasActionItem: Boolean(actionItem || state?.actionItemId),
    });
    if (keys.length === 0) continue;
    const targetHref = await resolveOwnedRecommendationTarget(
      db,
      access,
      recommendation.key,
      knownTargets,
    );
    needsOwnerConfirmation.push({
      id: recommendation.key,
      targetEntityType: "RECOMMENDATION",
      targetEntityId: recommendation.key,
      targetLabel: recommendation.title,
      targetHref: targetHref?.href ?? null,
      relatedAreaHref: await relatedAreaHref(db, access, recommendation.href),
      why: recommendation.why,
      recordedStatus: state?.status ?? null,
      availableActions: keys.map((key) => catalogSummary(key)),
    });
  }

  const recordedOwnerPlanState: ActionCenterRecordedState[] = [];

  for (const item of actionItems) {
    const recommendation = recommendationByKey.get(item.recommendationKey);
    const targetHref = await resolveOwnedRecommendationTarget(
      db,
      access,
      item.recommendationKey,
      knownTargets,
    );
    recordedOwnerPlanState.push({
      id: item.id,
      recordKind: "ACTION_ITEM",
      origin: ACTION_CENTER_ORIGIN_NOT_RECORDED,
      targetEntityType: "RECOMMENDATION",
      targetEntityId: item.recommendationKey,
      targetLabel: recommendation?.title ?? item.title,
      targetHref: targetHref?.href ?? null,
      relatedAreaHref: await relatedAreaHref(db, access, recommendation?.href),
      why: item.notes || recommendation?.why || null,
      recordedStatus: item.status,
      recordedAt: item.updatedAt.toISOString(),
      recordedAtLabel: formatDateTime(item.updatedAt, timeZone),
      actionItemId: item.id,
      actionItemStatus: item.status,
      history: [],
    });
  }

  for (const state of states) {
    const recommendation = recommendationByKey.get(state.recommendationKey);
    const targetHref = await resolveOwnedRecommendationTarget(
      db,
      access,
      state.recommendationKey,
      knownTargets,
    );
    recordedOwnerPlanState.push({
      id: state.id,
      recordKind: "RECOMMENDATION_STATE",
      origin: ACTION_CENTER_ORIGIN_NOT_RECORDED,
      targetEntityType: "RECOMMENDATION",
      targetEntityId: state.recommendationKey,
      targetLabel: recommendation?.title ?? state.recommendationKey,
      targetHref: targetHref?.href ?? null,
      relatedAreaHref: await relatedAreaHref(db, access, recommendation?.href),
      why: recommendation?.why ?? null,
      recordedStatus: state.status,
      recordedAt: state.updatedAt.toISOString(),
      recordedAtLabel: formatDateTime(state.updatedAt, timeZone),
      actionItemId: state.actionItemId,
      actionItemStatus: null,
      history: readRecordedHistory(state.history, timeZone),
    });
  }

  return {
    timeZone,
    catalog: CONTROLLED_ACTION_CATALOG.map((row) => ({
      actionKey: row.key,
      displayLabel: row.displayLabel,
      purpose: row.purpose,
      approvalClass: row.approvalClass,
    })),
    needsOwnerConfirmation,
    recordedOwnerPlanState,
  };
}

export async function loadControlledActionCenterItem(
  db: Db,
  access: BusinessAccess,
  rawId: string,
): Promise<ControlledActionCenterDetail | null> {
  authorizeRead(access);
  const id = decodeURIComponent(rawId).trim();
  if (!id) return null;

  const [actionItem, state] = await Promise.all([
    db.businessActionItem.findFirst({
      where: { id, businessId: access.businessId },
    }),
    db.bsosRecommendationState.findFirst({
      where: { id, businessId: access.businessId },
    }),
  ]);

  const recommendationKey = actionItem?.recommendationKey ?? state?.recommendationKey ?? id;
  const center = await loadControlledActionCenter(db, access);
  const live = center.needsOwnerConfirmation.find((row) => row.targetEntityId === recommendationKey) ?? null;
  const recordedOwnerPlanState = center.recordedOwnerPlanState.filter(
    (row) =>
      row.id === id ||
      row.actionItemId === id ||
      row.targetEntityId === recommendationKey,
  );

  if (!live && recordedOwnerPlanState.length === 0) {
    const catalog = await loadCanonicalRecommendationCatalog(db, access.businessId);
    const recommendation = catalog.recommendations.find((item) => item.key === id);
    if (!recommendation) return null;
    const targetHref = await resolveOwnedActionTargetLink(db, access, {
      type: "RECOMMENDATION",
      id: recommendation.key,
    });
    return {
      id: recommendation.key,
      live: {
        id: recommendation.key,
        targetEntityType: "RECOMMENDATION",
        targetEntityId: recommendation.key,
        targetLabel: recommendation.title,
        targetHref: targetHref?.href ?? null,
        relatedAreaHref: await relatedAreaHref(db, access, recommendation.href),
        why: recommendation.why,
        recordedStatus: null,
        availableActions: [],
      },
      recordedOwnerPlanState: [],
    };
  }

  return {
    id: recommendationKey,
    live,
    recordedOwnerPlanState,
  };
}

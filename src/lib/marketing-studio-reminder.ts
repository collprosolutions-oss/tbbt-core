/**
 * OWNER weekly Marketing Studio review reminder.
 *
 * Consent is explicit and default-off. Delivery always creates one
 * OWNER in-app reminder per business/week. Optional OWNER SMS uses the
 * existing communications provider and this business's dedicated
 * operational number only when both actually work. This module never
 * messages customers, auto-approves, publishes, or posts.
 *
 * Preview shares Production and skips migrate. Missing reminder table
 * or column fails closed with an unavailable state. This file never
 * runs request-time DDL. Other database errors are not treated as
 * missing schema.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { isUsableNormalizedPhone, normalizePhone } from "@/lib/customer-identity";
import { isCustomerMessagingConfigured } from "@/lib/customer-messaging/config";
import { sendOwnerSms } from "@/lib/customer-messaging/owner-sms";
import { getCustomerMessagingProvider } from "@/lib/customer-messaging/provider";
import type { CustomerMessagingProvider } from "@/lib/customer-messaging/types";
import {
  STUDIO_APPROVAL_QUEUE_STATUS,
  STUDIO_WEEKLY_REMINDER_CHANNEL,
  STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OPTED_IN_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OPTED_OUT_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE,
  STUDIO_WEEKLY_REMINDER_SMS_NO_DESTINATION,
  STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED,
  STUDIO_WEEKLY_REMINDER_SMS_NOT_SENT,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_ACCEPTED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_FAILED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_SENT,
  STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE,
  canManageStudioWeeklyReminder,
  resolveOwnerStudioReminderSmsTo,
  studioWeeklyReminderCopy,
  studioWeeklyReminderDelivery,
  studioWeeklyReminderSmsBody,
  studioWeeklyReminderSmsOutcomeLabel,
  studioWeeklyReminderWeekKey,
} from "@/lib/marketing";
import { MarketingError } from "@/lib/marketing-ops";

type Db = PrismaClient | Prisma.TransactionClient;

export type StudioWeeklyReminderDispatchReason =
  | "created"
  | "already_recorded"
  | "not_opted_in"
  | "nothing_awaiting"
  | "schema_unavailable";

export type StudioWeeklyReminderRecord = {
  id: string;
  businessId: string;
  weekKey: string;
  awaitingCount: number;
  channel: string;
  smsStatus: string;
  smsLabel: string;
  createdAt: Date;
};

export type StudioWeeklyReminderDispatchResult = {
  created: boolean;
  reason: StudioWeeklyReminderDispatchReason;
  reminder: StudioWeeklyReminderRecord | null;
  delivery: ReturnType<typeof studioWeeklyReminderDelivery>;
};

export type StudioWeeklyReminderState = {
  available: boolean;
  optedIn: boolean;
  weekKey: string;
  timezone: string;
  reminder: StudioWeeklyReminderRecord | null;
  delivery: ReturnType<typeof studioWeeklyReminderDelivery>;
  copy: string | null;
  inAppMessage: string;
};

export type StudioWeeklyReminderDeps = {
  smsPlatformConfigured?: boolean;
  /** Test hook. Fake or disconnected adapter only. Never a live send. */
  messagingProvider?: CustomerMessagingProvider;
  /** Test hook. Overrides Business.publicPhone as the OWNER destination. */
  ownerSmsTo?: string | null;
  /** Test hook. Runs before the business reminder lock is taken. */
  beforeSerialize?: () => Promise<void>;
};

const REMINDER_SCHEMA_NAME =
  /MarketingStudioWeeklyReminder|marketingStudioWeeklyReminder|studioWeeklyReviewReminderOptedIn/;
const OTHER_DB_ERROR_CODES = new Set(["P2002", "P2003", "P2014", "P2025"]);

function prismaErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: string }).code)
    : "";
}

function prismaErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

function prismaErrorMeta(error: unknown) {
  if (!error || typeof error !== "object" || !("meta" in error)) return "";
  try {
    return JSON.stringify((error as { meta?: unknown }).meta ?? "");
  } catch {
    return "";
  }
}

export function missingStudioWeeklyReminderSchema(error: unknown) {
  const code = prismaErrorCode(error);
  if (OTHER_DB_ERROR_CODES.has(code)) return false;
  const haystack = `${prismaErrorMessage(error)} ${prismaErrorMeta(error)}`;
  if (!REMINDER_SCHEMA_NAME.test(haystack)) return false;
  if (code === "P2021" || code === "P2022") return true;
  return (code === "" || code === "P2010") && /does not exist/i.test(haystack);
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function requireOwnerWeeklyReminder(access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  if (!canManageStudioWeeklyReminder(access.workspace.role)) {
    throw new MarketingError(STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

function reminderLockKey(businessId: string) {
  return `studio-weekly-reminder:${businessId}`;
}

async function runInTransaction<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ("$transaction" in db) {
    return db.$transaction(fn);
  }
  return fn(db);
}

async function withReminderLock<T>(
  db: Db,
  businessId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  deps?: StudioWeeklyReminderDeps,
): Promise<T> {
  if (deps?.beforeSerialize) await deps.beforeSerialize();
  return runInTransaction(db, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${reminderLockKey(businessId)}))`;
    return work(tx);
  });
}

function asReminder(row: {
  id: string;
  businessId: string;
  weekKey: string;
  awaitingCount: number;
  channel: string;
  smsStatus: string;
  smsLabel: string;
  createdAt: Date;
}): StudioWeeklyReminderRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    weekKey: row.weekKey,
    awaitingCount: row.awaitingCount,
    channel: row.channel,
    smsStatus: row.smsStatus,
    smsLabel: row.smsLabel,
    createdAt: row.createdAt,
  };
}

export function resolveStudioWeeklyReminderDelivery(input?: {
  platformConfigured?: boolean;
  dedicatedNumberAssigned?: boolean;
}) {
  return studioWeeklyReminderDelivery({
    platformConfigured: input?.platformConfigured ?? isCustomerMessagingConfigured(),
    dedicatedNumberAssigned: input?.dedicatedNumberAssigned === true,
  });
}

function reminderMessagingProvider(deps?: StudioWeeklyReminderDeps) {
  return deps?.messagingProvider ?? getCustomerMessagingProvider();
}

async function recordReminderSms(
  db: Db,
  reminder: StudioWeeklyReminderRecord,
  smsStatus: string,
  smsLabel: string,
): Promise<StudioWeeklyReminderRecord> {
  const updated = await db.marketingStudioWeeklyReminder.updateMany({
    where: { id: reminder.id, businessId: reminder.businessId },
    data: { smsStatus, smsLabel },
  });
  if (updated.count !== 1) return { ...reminder, smsStatus, smsLabel };
  const row = await db.marketingStudioWeeklyReminder.findFirst({
    where: { id: reminder.id, businessId: reminder.businessId },
  });
  return row ? asReminder(row) : { ...reminder, smsStatus, smsLabel };
}

async function applyOwnerStudioWeeklyReminderSms(
  db: Db,
  result: StudioWeeklyReminderDispatchResult,
  deps?: StudioWeeklyReminderDeps,
): Promise<StudioWeeklyReminderDispatchResult> {
  if (!result.created || !result.reminder) return result;

  const business = await db.business.findFirst({
    where: { id: result.reminder.businessId },
    select: { operationalSmsNumber: true, publicPhone: true },
  });
  const fromDigits = normalizePhone(business?.operationalSmsNumber);
  const toDigits = resolveOwnerStudioReminderSmsTo({
    publicPhone: business?.publicPhone,
    override: deps?.ownerSmsTo,
  });
  const provider = reminderMessagingProvider(deps);
  const platformConfigured = deps?.smsPlatformConfigured ?? isCustomerMessagingConfigured();
  const smsConnected = result.delivery.smsConnected && platformConfigured === true;

  if (!smsConnected || !provider.connected || !isUsableNormalizedPhone(fromDigits)) {
    const reminder = await recordReminderSms(
      db,
      result.reminder,
      STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED,
      STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED,
    );
    return { ...result, reminder };
  }

  if (!toDigits) {
    const reminder = await recordReminderSms(
      db,
      result.reminder,
      STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT,
      STUDIO_WEEKLY_REMINDER_SMS_NO_DESTINATION,
    );
    return { ...result, reminder };
  }

  const sent = await sendOwnerSms({
    provider,
    businessId: result.reminder.businessId,
    communicationId: result.reminder.id,
    from: fromDigits,
    to: toDigits,
    body: studioWeeklyReminderSmsBody(result.reminder.awaitingCount),
    purpose: "STUDIO_WEEKLY_REMINDER",
  });

  const smsStatus = sent.ok
    ? sent.status === "SENT"
      ? STUDIO_WEEKLY_REMINDER_SMS_STATUS_SENT
      : STUDIO_WEEKLY_REMINDER_SMS_STATUS_ACCEPTED
    : sent.status === "FAILED"
      ? STUDIO_WEEKLY_REMINDER_SMS_STATUS_FAILED
      : STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT;
  const smsLabel =
    studioWeeklyReminderSmsOutcomeLabel(smsStatus, sent.ok ? null : sent.error) ??
    STUDIO_WEEKLY_REMINDER_SMS_NOT_SENT;
  const reminder = await recordReminderSms(db, result.reminder, smsStatus, smsLabel);
  return { ...result, reminder };
}

function unavailableReminderState(
  now: Date,
  business: { timezone?: string | null; operationalSmsNumber?: string | null } | null,
  deps?: StudioWeeklyReminderDeps,
): StudioWeeklyReminderState {
  const timezone = resolveBusinessTimeZone(business);
  return {
    available: false,
    optedIn: false,
    weekKey: studioWeeklyReminderWeekKey(now, timezone),
    timezone,
    reminder: null,
    delivery: resolveStudioWeeklyReminderDelivery({
      platformConfigured: deps?.smsPlatformConfigured,
      dedicatedNumberAssigned: Boolean(business?.operationalSmsNumber?.trim()),
    }),
    copy: null,
    inAppMessage: STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE,
  };
}

export async function loadStudioWeeklyReminderState(
  db: Db,
  businessId: string,
  now = new Date(),
  deps?: StudioWeeklyReminderDeps,
): Promise<StudioWeeklyReminderState> {
  const business = await db.business.findFirst({
    where: { id: businessId },
    select: { id: true, timezone: true, operationalSmsNumber: true },
  });
  try {
    const [settings, reminderRow] = await Promise.all([
      db.businessSettings.findUnique({
        where: { businessId },
        select: { studioWeeklyReviewReminderOptedIn: true },
      }),
      db.marketingStudioWeeklyReminder.findFirst({
        where: {
          businessId,
          weekKey: studioWeeklyReminderWeekKey(now, resolveBusinessTimeZone(business)),
        },
      }),
    ]);
    const timezone = resolveBusinessTimeZone(business);
    const weekKey = studioWeeklyReminderWeekKey(now, timezone);
    const delivery = resolveStudioWeeklyReminderDelivery({
      platformConfigured: deps?.smsPlatformConfigured,
      dedicatedNumberAssigned: Boolean(business?.operationalSmsNumber?.trim()),
    });
    const reminder = reminderRow ? asReminder(reminderRow) : null;
    return {
      available: true,
      optedIn: settings?.studioWeeklyReviewReminderOptedIn === true,
      weekKey,
      timezone,
      reminder,
      delivery,
      copy: reminder ? studioWeeklyReminderCopy(reminder.awaitingCount) : null,
      inAppMessage: STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE,
    };
  } catch (error) {
    if (missingStudioWeeklyReminderSchema(error)) {
      return unavailableReminderState(now, business, deps);
    }
    throw error;
  }
}

async function dispatchAfterLock(
  db: Prisma.TransactionClient,
  businessId: string,
  now: Date,
  deps?: StudioWeeklyReminderDeps,
): Promise<StudioWeeklyReminderDispatchResult> {
  const state = await loadStudioWeeklyReminderState(db, businessId, now, deps);
  const delivery = state.delivery;
  if (!state.available) {
    return { created: false, reason: "schema_unavailable", reminder: null, delivery };
  }
  if (!state.optedIn) {
    return { created: false, reason: "not_opted_in", reminder: null, delivery };
  }
  if (state.reminder) {
    return { created: false, reason: "already_recorded", reminder: state.reminder, delivery };
  }

  const awaitingCount = await db.marketingContent.count({
    where: { businessId, status: STUDIO_APPROVAL_QUEUE_STATUS },
  });
  if (awaitingCount < 1) {
    return { created: false, reason: "nothing_awaiting", reminder: null, delivery };
  }

  try {
    const created = await db.marketingStudioWeeklyReminder.create({
      data: {
        businessId,
        weekKey: state.weekKey,
        awaitingCount,
        channel: STUDIO_WEEKLY_REMINDER_CHANNEL,
        smsStatus: delivery.smsStatus,
        smsLabel: delivery.smsLabel ?? "",
      },
    });
    return {
      created: true,
      reason: "created",
      reminder: asReminder(created),
      delivery,
    };
  } catch (error) {
    if (missingStudioWeeklyReminderSchema(error)) {
      return { created: false, reason: "schema_unavailable", reminder: null, delivery };
    }
    if (!isUniqueConflict(error)) throw error;
    const existing = await db.marketingStudioWeeklyReminder.findFirst({
      where: { businessId, weekKey: state.weekKey },
    });
    return {
      created: false,
      reason: "already_recorded",
      reminder: existing ? asReminder(existing) : null,
      delivery,
    };
  }
}

export async function setStudioWeeklyReviewReminderOptIn(
  db: Db,
  access: BusinessAccess,
  optedIn: boolean,
  now = new Date(),
  deps?: StudioWeeklyReminderDeps,
) {
  requireOwnerWeeklyReminder(access);
  try {
    return await withReminderLock(
      db,
      access.businessId,
      async (tx) => {
        const state = await loadStudioWeeklyReminderState(tx, access.businessId, now, deps);
        if (!state.available) {
          throw new MarketingError(STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE);
        }
        await tx.businessSettings.upsert({
          where: { businessId: access.businessId },
          create: {
            businessId: access.businessId,
            studioWeeklyReviewReminderOptedIn: optedIn,
          },
          update: {
            studioWeeklyReviewReminderOptedIn: optedIn,
          },
        });
        const dispatch = optedIn ? await dispatchAfterLock(tx, access.businessId, now, deps) : null;
        if (dispatch?.reason === "schema_unavailable") {
          throw new MarketingError(STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE);
        }
        return {
          optedIn,
          message: optedIn ? STUDIO_WEEKLY_REMINDER_OPTED_IN_MESSAGE : STUDIO_WEEKLY_REMINDER_OPTED_OUT_MESSAGE,
          dispatch: dispatch ? await applyOwnerStudioWeeklyReminderSms(tx, dispatch, deps) : null,
        };
      },
      deps,
    );
  } catch (error) {
    if (error instanceof MarketingError) throw error;
    if (missingStudioWeeklyReminderSchema(error)) {
      throw new MarketingError(STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }
}

export async function dispatchStudioWeeklyReviewReminder(
  db: Db,
  businessId: string,
  now = new Date(),
  deps?: StudioWeeklyReminderDeps,
): Promise<StudioWeeklyReminderDispatchResult> {
  try {
    const result = await withReminderLock(
      db,
      businessId,
      (tx) => dispatchAfterLock(tx, businessId, now, deps),
      deps,
    );
    try {
      return await applyOwnerStudioWeeklyReminderSms(db, result, deps);
    } catch (error) {
      if (missingStudioWeeklyReminderSchema(error)) {
        return {
          created: false,
          reason: "schema_unavailable",
          reminder: null,
          delivery: result.delivery,
        };
      }
      throw error;
    }
  } catch (error) {
    if (missingStudioWeeklyReminderSchema(error)) {
      return {
        created: false,
        reason: "schema_unavailable",
        reminder: null,
        delivery: resolveStudioWeeklyReminderDelivery({
          platformConfigured: deps?.smsPlatformConfigured,
          dedicatedNumberAssigned: false,
        }),
      };
    }
    throw error;
  }
}

export function studioWeeklyReminderSmsLabel(state: StudioWeeklyReminderState) {
  if (!state.available) return null;
  return state.reminder?.smsLabel || state.delivery.smsLabel || STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED;
}

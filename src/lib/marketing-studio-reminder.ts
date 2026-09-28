/**
 * OWNER weekly Marketing Studio review reminder.
 *
 * Consent is explicit and default-off. Delivery always creates one
 * OWNER in-app reminder per business/week. Optional OWNER SMS uses an
 * explicit OWNER-controlled destination the OWNER opted in, plus the
 * communications provider and this business's dedicated operational
 * number, only when those actually work. The public company phone is
 * never the destination. The provider is never called inside a transaction
 * that can roll back the reminder, and never during a Marketing page
 * load. Weekly owner SMS is sent only by the secret-protected daily
 * dispatcher when the business local day is Monday. This module never
 * messages customers, auto-approves, publishes, or posts.
 *
 * Preview shares Production and skips migrate. Missing reminder table
 * or column fails closed with an unavailable state. This file never
 * runs request-time DDL. Other database errors are not treated as
 * missing schema.
 */
import { timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import type { CustomerMessageDeliveryUpdate } from "@/lib/customer-messaging/types";
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
  STUDIO_WEEKLY_REMINDER_OWNER_SMS_INVALID_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OWNER_SMS_SAVED_MESSAGE,
  STUDIO_WEEKLY_REMINDER_SMS_BLOCKED,
  STUDIO_WEEKLY_REMINDER_SMS_NO_DESTINATION,
  STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED,
  STUDIO_WEEKLY_REMINDER_SMS_NOT_OPTED_IN,
  STUDIO_WEEKLY_REMINDER_SMS_NOT_SENT,
  STUDIO_WEEKLY_REMINDER_SMS_OPTED_OUT,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_BLOCKED,
  STUDIO_WEEKLY_REMINDER_SMS_STOPPED,
  STUDIO_WEEKLY_REMINDER_SMS_TIMED_OUT,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_ACCEPTED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_FAILED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_SENT,
  STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE,
  OWNER_SMS_BLOCKED_PROVIDER_CODE,
  canManageStudioWeeklyReminder,
  isOwnerSmsBlockedProviderCode,
  isStudioWeeklyReminderSendWindow,
  maskOwnerSmsDestination,
  resolveOwnerStudioReminderSmsTo,
  studioWeeklyReminderCopy,
  studioWeeklyReminderDelivery,
  studioWeeklyReminderSafeSmsLabel,
  studioWeeklyReminderSmsBody,
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
  smsSendClaimedAt: Date | null;
  smsProviderMessageId: string | null;
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
  ownerSmsTo: string | null;
  ownerSmsToMasked: string | null;
  ownerSmsOptedIn: boolean;
  ownerSmsStopped: boolean;
  ownerSmsBlocked: boolean;
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
  /** Test hook. Runs before the business reminder lock is taken. */
  beforeSerialize?: () => Promise<void>;
  /** Test hook. Runs after the reminder row is committed, before send. */
  beforeOwnerSmsSend?: () => Promise<void>;
  /**
   * Test hook. Runs after this run selected a destination and before the
   * locked revalidate+claim. Destination updates that commit here win.
   */
  beforeOwnerSmsClaim?: () => Promise<void>;
  /**
   * Test hook. Runs inside the claim transaction after the per-business
   * advisory lock is held and before the destination revalidate+claim.
   */
  afterOwnerSmsClaimLockAcquired?: () => Promise<void>;
  /**
   * Test hook. Runs inside any withReminderLock transaction after the
   * per-business advisory lock is held. Used to prove STOP/block writes
   * wait while a claim transaction holds the lock.
   */
  afterReminderLockAcquired?: () => Promise<void>;
  /** Test hook. Throws after provider acceptance to simulate a failed status write. */
  afterProviderAccepted?: () => Promise<void>;
};

const REMINDER_SCHEMA_NAME =
  /MarketingStudioWeeklyReminder|marketingStudioWeeklyReminder|studioWeeklyReviewReminderOptedIn|studioWeeklyReminderOwnerSmsTo|studioWeeklyReminderOwnerSmsOptedIn|studioWeeklyReminderOwnerSmsStopAt|studioWeeklyReminderOwnerSmsBlockedAt|smsSendClaimedAt|smsProviderMessageId|smsProviderError/;
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

function cronSecretEquals(provided: string, expected: string) {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authorizeStudioWeeklyReminderCron(headers: { get(name: string): string | null }) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const auth = headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const header = (headers.get("x-cron-secret") ?? "").trim();
  return (
    (bearer !== "" && cronSecretEquals(bearer, secret)) ||
    (header !== "" && cronSecretEquals(header, secret))
  );
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
    if (deps?.afterReminderLockAcquired) await deps.afterReminderLockAcquired();
    return work(tx);
  });
}

export type OwnerStudioReminderConsentWriteResult = {
  matched: boolean;
  applied: boolean;
  reason: string;
};

async function ownerDestinationMatches(
  tx: Prisma.TransactionClient,
  businessId: string,
  fromDigits: string,
) {
  const settings = await tx.businessSettings.findUnique({
    where: { businessId },
    select: {
      studioWeeklyReminderOwnerSmsTo: true,
      studioWeeklyReminderOwnerSmsStopAt: true,
    },
  });
  const ownerDigits = normalizePhone(settings?.studioWeeklyReminderOwnerSmsTo);
  if (!settings || !ownerDigits || ownerDigits !== fromDigits) {
    return { settings: null, matched: false as const };
  }
  return { settings, matched: true as const };
}

/**
 * Persist an inbound OWNER STOP under the same per-business advisory
 * lock as claim and destination updates. Provider I/O stays outside.
 */
export async function recordOwnerStudioReminderStop(
  db: Db,
  businessId: string,
  fromDigits: string,
  deps?: StudioWeeklyReminderDeps,
): Promise<OwnerStudioReminderConsentWriteResult> {
  return withReminderLock(
    db,
    businessId,
    async (tx) => {
      const matched = await ownerDestinationMatches(tx, businessId, fromDigits);
      if (!matched.matched) {
        return { matched: false, applied: false, reason: "not_owner_destination" };
      }
      if (matched.settings.studioWeeklyReminderOwnerSmsStopAt) {
        return { matched: true, applied: true, reason: "owner_stop_idempotent" };
      }
      await tx.businessSettings.update({
        where: { businessId },
        data: {
          studioWeeklyReminderOwnerSmsOptedIn: false,
          studioWeeklyReminderOwnerSmsStopAt: new Date(),
        },
      });
      return { matched: true, applied: true, reason: "owner_stopped" };
    },
    deps,
  );
}

/**
 * Clear an inbound OWNER START under the same per-business advisory
 * lock as claim and destination updates. Provider I/O stays outside.
 */
export async function recordOwnerStudioReminderStart(
  db: Db,
  businessId: string,
  fromDigits: string,
  deps?: StudioWeeklyReminderDeps,
): Promise<OwnerStudioReminderConsentWriteResult> {
  return withReminderLock(
    db,
    businessId,
    async (tx) => {
      const matched = await ownerDestinationMatches(tx, businessId, fromDigits);
      if (!matched.matched) {
        return { matched: false, applied: false, reason: "not_owner_destination" };
      }
      if (!matched.settings.studioWeeklyReminderOwnerSmsStopAt) {
        return { matched: true, applied: true, reason: "owner_start_not_applicable" };
      }
      await tx.businessSettings.update({
        where: { businessId },
        data: { studioWeeklyReminderOwnerSmsStopAt: null },
      });
      return { matched: true, applied: true, reason: "owner_stop_cleared" };
    },
    deps,
  );
}

/**
 * Persist a provider block (Twilio 21610 / send-time or delivery
 * webhook) under the same per-business advisory lock as claim.
 * The provider call itself stays outside this lock.
 */
export async function recordOwnerStudioReminderBlocked(
  db: Db,
  businessId: string,
  deps?: StudioWeeklyReminderDeps,
): Promise<void> {
  await withReminderLock(
    db,
    businessId,
    async (tx) => {
      await tx.businessSettings.updateMany({
        where: { businessId },
        data: { studioWeeklyReminderOwnerSmsBlockedAt: new Date() },
      });
    },
    deps,
  );
}

function asReminder(row: {
  id: string;
  businessId: string;
  weekKey: string;
  awaitingCount: number;
  channel: string;
  smsStatus: string;
  smsLabel: string;
  smsSendClaimedAt?: Date | null;
  smsProviderMessageId?: string | null;
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
    smsSendClaimedAt: row.smsSendClaimedAt ?? null,
    smsProviderMessageId: row.smsProviderMessageId ?? null,
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
  extra?: { providerMessageId?: string | null; providerError?: string | null },
): Promise<StudioWeeklyReminderRecord> {
  const updated = await db.marketingStudioWeeklyReminder.updateMany({
    where: { id: reminder.id, businessId: reminder.businessId },
    data: {
      smsStatus,
      smsLabel,
      ...(extra?.providerMessageId !== undefined
        ? { smsProviderMessageId: extra.providerMessageId }
        : {}),
      ...(extra?.providerError !== undefined ? { smsProviderError: extra.providerError } : {}),
    },
  });
  if (updated.count !== 1) {
    return { ...reminder, smsStatus, smsLabel, smsProviderMessageId: extra?.providerMessageId ?? reminder.smsProviderMessageId };
  }
  const row = await db.marketingStudioWeeklyReminder.findFirst({
    where: { id: reminder.id, businessId: reminder.businessId },
  });
  return row ? asReminder(row) : { ...reminder, smsStatus, smsLabel };
}

async function loadReminderRow(db: Db, reminder: StudioWeeklyReminderRecord) {
  const row = await db.marketingStudioWeeklyReminder.findFirst({
    where: { id: reminder.id, businessId: reminder.businessId },
  });
  return row ? asReminder(row) : reminder;
}

type OwnerSmsClaimOutcome =
  | "claimed"
  | "already_claimed"
  | "destination_changed"
  | "opted_out"
  | "stopped"
  | "blocked";

/**
 * Revalidate the selected E.164 destination and claim in the same
 * per-business advisory transaction that destination updates take.
 * A destination change that commits first cannot be claimed for the
 * old number; a claim that commits first is visible to later updates.
 */
async function claimOwnerStudioReminderSmsIfDestinationUnchanged(
  db: Db,
  reminder: StudioWeeklyReminderRecord,
  selectedTo: string,
  deps?: StudioWeeklyReminderDeps,
): Promise<OwnerSmsClaimOutcome> {
  return withReminderLock(db, reminder.businessId, async (tx) => {
    if (deps?.afterOwnerSmsClaimLockAcquired) await deps.afterOwnerSmsClaimLockAcquired();
    const row = await tx.marketingStudioWeeklyReminder.findFirst({
      where: { id: reminder.id, businessId: reminder.businessId },
      select: { smsSendClaimedAt: true },
    });
    if (!row || row.smsSendClaimedAt) return "already_claimed";

    const settings = await tx.businessSettings.findUnique({
      where: { businessId: reminder.businessId },
      select: {
        studioWeeklyReviewReminderOptedIn: true,
        studioWeeklyReminderOwnerSmsTo: true,
        studioWeeklyReminderOwnerSmsOptedIn: true,
        studioWeeklyReminderOwnerSmsStopAt: true,
        studioWeeklyReminderOwnerSmsBlockedAt: true,
      },
    });
    if (
      settings?.studioWeeklyReviewReminderOptedIn !== true ||
      settings.studioWeeklyReminderOwnerSmsOptedIn !== true
    ) {
      return "opted_out";
    }
    if (settings.studioWeeklyReminderOwnerSmsStopAt) return "stopped";
    if (settings.studioWeeklyReminderOwnerSmsBlockedAt) return "blocked";

    const currentTo = resolveOwnerStudioReminderSmsTo({
      ownerSmsTo: settings.studioWeeklyReminderOwnerSmsTo,
    });
    if (!currentTo || currentTo !== selectedTo) return "destination_changed";

    const updated = await tx.marketingStudioWeeklyReminder.updateMany({
      where: {
        id: reminder.id,
        businessId: reminder.businessId,
        smsSendClaimedAt: null,
      },
      data: { smsSendClaimedAt: new Date() },
    });
    return updated.count === 1 ? "claimed" : "already_claimed";
  });
}

/**
 * Optional OWNER SMS after the reminder row is committed. Never called
 * inside a transaction that can roll back MarketingStudioWeeklyReminder.
 * Rechecks opt-out and the selected E.164 destination at the send
 * boundary, under the same per-business advisory lock as destination
 * updates. Claims the send before the provider so a failed later
 * status write cannot cause a second send.
 */
async function deliverOwnerStudioWeeklyReminderSms(
  db: Db,
  result: StudioWeeklyReminderDispatchResult,
  deps?: StudioWeeklyReminderDeps,
  now = new Date(),
): Promise<StudioWeeklyReminderDispatchResult> {
  if (!result.reminder) return result;

  const existing = await loadReminderRow(db, result.reminder);
  if (existing.smsSendClaimedAt) {
    return { ...result, reminder: existing };
  }

  if (deps?.beforeOwnerSmsSend) await deps.beforeOwnerSmsSend();

  const [business, settings] = await Promise.all([
    db.business.findFirst({
      where: { id: existing.businessId },
      select: { operationalSmsNumber: true, timezone: true },
    }),
    db.businessSettings.findUnique({
      where: { businessId: existing.businessId },
      select: {
        studioWeeklyReviewReminderOptedIn: true,
        studioWeeklyReminderOwnerSmsTo: true,
        studioWeeklyReminderOwnerSmsOptedIn: true,
        studioWeeklyReminderOwnerSmsStopAt: true,
        studioWeeklyReminderOwnerSmsBlockedAt: true,
      },
    }),
  ]);

  if (settings?.studioWeeklyReviewReminderOptedIn !== true) {
    const reminder = await recordReminderSms(
      db,
      existing,
      STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT,
      STUDIO_WEEKLY_REMINDER_SMS_OPTED_OUT,
    );
    return { ...result, reminder };
  }

  if (!isStudioWeeklyReminderSendWindow(now, resolveBusinessTimeZone(business))) {
    return { ...result, reminder: existing };
  }

  const fromDigits = normalizePhone(business?.operationalSmsNumber);
  const toDigits = resolveOwnerStudioReminderSmsTo({
    ownerSmsTo: settings.studioWeeklyReminderOwnerSmsTo,
  });
  const provider = reminderMessagingProvider(deps);
  const platformConfigured = deps?.smsPlatformConfigured ?? isCustomerMessagingConfigured();
  const smsConnected = result.delivery.smsConnected && platformConfigured === true;

  if (!smsConnected || !provider.connected || !isUsableNormalizedPhone(fromDigits)) {
    const reminder = await recordReminderSms(
      db,
      existing,
      STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED,
      STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED,
    );
    return { ...result, reminder };
  }

  if (settings.studioWeeklyReminderOwnerSmsStopAt) {
    const reminder = await recordReminderSms(
      db,
      existing,
      STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT,
      STUDIO_WEEKLY_REMINDER_SMS_STOPPED,
    );
    return { ...result, reminder };
  }
  if (settings.studioWeeklyReminderOwnerSmsBlockedAt) {
    const reminder = await recordReminderSms(
      db,
      existing,
      STUDIO_WEEKLY_REMINDER_SMS_STATUS_BLOCKED,
      STUDIO_WEEKLY_REMINDER_SMS_BLOCKED,
    );
    return { ...result, reminder };
  }
  if (settings.studioWeeklyReminderOwnerSmsOptedIn !== true) {
    const reminder = await recordReminderSms(
      db,
      existing,
      STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT,
      STUDIO_WEEKLY_REMINDER_SMS_NOT_OPTED_IN,
    );
    return { ...result, reminder };
  }

  if (!toDigits) {
    const reminder = await recordReminderSms(
      db,
      existing,
      STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT,
      STUDIO_WEEKLY_REMINDER_SMS_NO_DESTINATION,
    );
    return { ...result, reminder };
  }

  if (deps?.beforeOwnerSmsClaim) await deps.beforeOwnerSmsClaim();

  const claim = await claimOwnerStudioReminderSmsIfDestinationUnchanged(db, existing, toDigits, deps);
  if (claim === "destination_changed") {
    return { ...result, reminder: await loadReminderRow(db, existing) };
  }
  if (claim === "opted_out") {
    const reminder = await recordReminderSms(
      db,
      existing,
      STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT,
      STUDIO_WEEKLY_REMINDER_SMS_OPTED_OUT,
    );
    return { ...result, reminder };
  }
  if (claim === "stopped") {
    const reminder = await recordReminderSms(
      db,
      existing,
      STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT,
      STUDIO_WEEKLY_REMINDER_SMS_STOPPED,
    );
    return { ...result, reminder };
  }
  if (claim === "blocked") {
    const reminder = await recordReminderSms(
      db,
      existing,
      STUDIO_WEEKLY_REMINDER_SMS_STATUS_BLOCKED,
      STUDIO_WEEKLY_REMINDER_SMS_BLOCKED,
    );
    return { ...result, reminder };
  }
  if (claim !== "claimed") {
    return { ...result, reminder: await loadReminderRow(db, existing) };
  }

  const sent = await sendOwnerSms({
    provider,
    businessId: existing.businessId,
    communicationId: existing.id,
    from: fromDigits,
    to: toDigits,
    body: studioWeeklyReminderSmsBody(existing.awaitingCount),
    purpose: "STUDIO_WEEKLY_REMINDER",
  });

  try {
    if (deps?.afterProviderAccepted && sent.ok) {
      await deps.afterProviderAccepted();
    }
  } catch {
    return { ...result, reminder: await loadReminderRow(db, existing) };
  }

  try {
    const blocked = !sent.ok && isOwnerSmsBlockedProviderCode(sent.errorCode);
    if (blocked) {
      await recordOwnerStudioReminderBlocked(db, existing.businessId);
    }
    const timedOut = !sent.ok && sent.error === "The messaging provider timed out.";
    const smsStatus = sent.ok
      ? sent.status === "SENT"
        ? STUDIO_WEEKLY_REMINDER_SMS_STATUS_SENT
        : STUDIO_WEEKLY_REMINDER_SMS_STATUS_ACCEPTED
      : blocked
        ? STUDIO_WEEKLY_REMINDER_SMS_STATUS_BLOCKED
        : sent.status === "FAILED"
          ? STUDIO_WEEKLY_REMINDER_SMS_STATUS_FAILED
          : STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT;
    const smsLabel = blocked
      ? STUDIO_WEEKLY_REMINDER_SMS_BLOCKED
      : timedOut
        ? STUDIO_WEEKLY_REMINDER_SMS_TIMED_OUT
        : studioWeeklyReminderSafeSmsLabel(smsStatus, null);
    const reminder = await recordReminderSms(db, existing, smsStatus, smsLabel, {
      providerMessageId: sent.ok ? sent.providerMessageId : existing.smsProviderMessageId,
      providerError: sent.ok ? null : sent.error,
    });
    return { ...result, reminder };
  } catch {
    return { ...result, reminder: await loadReminderRow(db, existing) };
  }
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
    ownerSmsTo: null,
    ownerSmsToMasked: null,
    ownerSmsOptedIn: false,
    ownerSmsStopped: false,
    ownerSmsBlocked: false,
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
        select: {
          studioWeeklyReviewReminderOptedIn: true,
          studioWeeklyReminderOwnerSmsTo: true,
          studioWeeklyReminderOwnerSmsOptedIn: true,
          studioWeeklyReminderOwnerSmsStopAt: true,
          studioWeeklyReminderOwnerSmsBlockedAt: true,
        },
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
      ownerSmsTo: settings?.studioWeeklyReminderOwnerSmsTo ?? null,
      ownerSmsToMasked: maskOwnerSmsDestination(settings?.studioWeeklyReminderOwnerSmsTo),
      ownerSmsOptedIn: settings?.studioWeeklyReminderOwnerSmsOptedIn === true,
      ownerSmsStopped: Boolean(settings?.studioWeeklyReminderOwnerSmsStopAt),
      ownerSmsBlocked: Boolean(settings?.studioWeeklyReminderOwnerSmsBlockedAt),
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
    const locked = await withReminderLock(
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
          dispatch,
        };
      },
      deps,
    );
    return locked;
  } catch (error) {
    if (error instanceof MarketingError) throw error;
    if (missingStudioWeeklyReminderSchema(error)) {
      throw new MarketingError(STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }
}

export async function createStudioWeeklyReviewReminder(
  db: Db,
  businessId: string,
  now = new Date(),
  deps?: StudioWeeklyReminderDeps,
): Promise<StudioWeeklyReminderDispatchResult> {
  try {
    return await withReminderLock(
      db,
      businessId,
      (tx) => dispatchAfterLock(tx, businessId, now, deps),
      deps,
    );
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

export async function dispatchStudioWeeklyReviewReminder(
  db: Db,
  businessId: string,
  now = new Date(),
  deps?: StudioWeeklyReminderDeps,
): Promise<StudioWeeklyReminderDispatchResult> {
  const result = await createStudioWeeklyReviewReminder(db, businessId, now, deps);
  try {
    return await deliverOwnerStudioWeeklyReminderSms(db, result, deps, now);
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
}

export type StudioWeeklyReminderScheduleResult = StudioWeeklyReminderDispatchResult & {
  businessId: string;
  skipped?: "outside_send_window";
};

export async function runScheduledStudioWeeklyReminders(
  db: Db,
  now = new Date(),
  deps?: StudioWeeklyReminderDeps,
): Promise<StudioWeeklyReminderScheduleResult[]> {
  let rows: Array<{ businessId: string }>;
  try {
    rows = await db.businessSettings.findMany({
      where: { studioWeeklyReviewReminderOptedIn: true },
      select: { businessId: true },
    });
  } catch (error) {
    if (missingStudioWeeklyReminderSchema(error)) return [];
    throw error;
  }

  const results: StudioWeeklyReminderScheduleResult[] = [];
  for (const row of rows) {
    const business = await db.business.findFirst({
      where: { id: row.businessId },
      select: { timezone: true, operationalSmsNumber: true },
    });
    const timezone = resolveBusinessTimeZone(business);
    const delivery = resolveStudioWeeklyReminderDelivery({
      platformConfigured: deps?.smsPlatformConfigured,
      dedicatedNumberAssigned: Boolean(business?.operationalSmsNumber?.trim()),
    });
    if (!isStudioWeeklyReminderSendWindow(now, timezone)) {
      results.push({
        businessId: row.businessId,
        created: false,
        reason: "already_recorded",
        reminder: null,
        delivery,
        skipped: "outside_send_window",
      });
      continue;
    }
    const dispatched = await dispatchStudioWeeklyReviewReminder(db, row.businessId, now, deps);
    results.push({ businessId: row.businessId, ...dispatched });
  }
  return results;
}

export function presentStudioWeeklyReminderForViewer(
  state: StudioWeeklyReminderState,
  viewerRole?: string | null,
): StudioWeeklyReminderState {
  const owner = viewerRole === "OWNER";
  const reminder = state.reminder
    ? {
        ...state.reminder,
        smsLabel: studioWeeklyReminderSafeSmsLabel(state.reminder.smsStatus, state.reminder.smsLabel),
      }
    : null;
  return {
    ...state,
    ownerSmsTo: owner ? state.ownerSmsTo : state.ownerSmsToMasked,
    reminder,
  };
}

export async function recordOwnerStudioReminderDeliveryBlock(
  db: Db,
  update: CustomerMessageDeliveryUpdate,
): Promise<{ applied: boolean; reason: string; communicationId?: string; businessId?: string } | null> {
  try {
    if (!update.providerMessageId) return null;
    const reminder = await db.marketingStudioWeeklyReminder.findFirst({
      where: { smsProviderMessageId: update.providerMessageId },
    });
    if (!reminder) return null;
    if (update.claimedBusinessId && update.claimedBusinessId !== reminder.businessId) {
      return { applied: false, reason: "tenant_mismatch", businessId: reminder.businessId };
    }
    const blocked =
      isOwnerSmsBlockedProviderCode(update.errorCode) ||
      isOwnerSmsBlockedProviderCode(update.failureReason);
    if (!blocked) {
      return { applied: false, reason: "not_owner_block", businessId: reminder.businessId };
    }
    await recordOwnerStudioReminderBlocked(db, reminder.businessId);
    await recordReminderSms(
      db,
      asReminder(reminder),
      STUDIO_WEEKLY_REMINDER_SMS_STATUS_BLOCKED,
      STUDIO_WEEKLY_REMINDER_SMS_BLOCKED,
      { providerError: update.failureReason ?? update.errorCode ?? OWNER_SMS_BLOCKED_PROVIDER_CODE },
    );
    return {
      applied: true,
      reason: "owner_blocked",
      communicationId: reminder.id,
      businessId: reminder.businessId,
    };
  } catch (error) {
    if (missingStudioWeeklyReminderSchema(error)) return null;
    throw error;
  }
}

export async function setStudioWeeklyReminderOwnerSms(
  db: Db,
  access: BusinessAccess,
  input: { destination: string; optedIn: boolean },
  now = new Date(),
  deps?: StudioWeeklyReminderDeps,
) {
  requireOwnerWeeklyReminder(access);
  const ownerSmsTo = resolveOwnerStudioReminderSmsTo({ ownerSmsTo: input.destination });
  if (input.optedIn && !ownerSmsTo) {
    throw new MarketingError(STUDIO_WEEKLY_REMINDER_OWNER_SMS_INVALID_MESSAGE);
  }
  try {
    return await withReminderLock(
      db,
      access.businessId,
      async (tx) => {
        const state = await loadStudioWeeklyReminderState(tx, access.businessId, now, deps);
        if (!state.available) {
          throw new MarketingError(STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE);
        }
        const destChanged = ownerSmsTo !== state.ownerSmsTo;
        await tx.businessSettings.upsert({
          where: { businessId: access.businessId },
          create: {
            businessId: access.businessId,
            studioWeeklyReminderOwnerSmsTo: ownerSmsTo,
            studioWeeklyReminderOwnerSmsOptedIn: input.optedIn,
          },
          update: {
            studioWeeklyReminderOwnerSmsTo: ownerSmsTo,
            studioWeeklyReminderOwnerSmsOptedIn: input.optedIn,
            ...(destChanged
              ? {
                  studioWeeklyReminderOwnerSmsStopAt: null,
                  studioWeeklyReminderOwnerSmsBlockedAt: null,
                }
              : input.optedIn
                ? { studioWeeklyReminderOwnerSmsStopAt: null }
                : {}),
          },
        });
        return {
          ownerSmsTo,
          ownerSmsOptedIn: input.optedIn,
          message: STUDIO_WEEKLY_REMINDER_OWNER_SMS_SAVED_MESSAGE,
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

export function studioWeeklyReminderSmsLabel(state: StudioWeeklyReminderState) {
  if (!state.available) return null;
  return state.reminder?.smsLabel || state.delivery.smsLabel || STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED;
}

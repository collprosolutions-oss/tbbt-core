/**
 * OWNER weekly Marketing Studio review reminder.
 *
 * Consent is explicit and default-off. Delivery uses the existing
 * OWNER-only in-app approval queue path. SMS is labeled honestly when
 * it is not actually configured. This module never messages customers,
 * auto-approves, publishes, or posts.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { isCustomerMessagingConfigured } from "@/lib/customer-messaging/config";
import {
  STUDIO_APPROVAL_QUEUE_STATUS,
  STUDIO_WEEKLY_REMINDER_CHANNEL,
  STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OPTED_IN_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OPTED_OUT_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE,
  STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED,
  canManageStudioWeeklyReminder,
  studioWeeklyReminderCopy,
  studioWeeklyReminderDelivery,
  studioWeeklyReminderWeekKey,
} from "@/lib/marketing";
import { MarketingError } from "@/lib/marketing-ops";

type Db = PrismaClient | Prisma.TransactionClient;

export type StudioWeeklyReminderDispatchReason =
  | "created"
  | "already_recorded"
  | "not_opted_in"
  | "nothing_awaiting";

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
  optedIn: boolean;
  weekKey: string;
  timezone: string;
  reminder: StudioWeeklyReminderRecord | null;
  delivery: ReturnType<typeof studioWeeklyReminderDelivery>;
  copy: string | null;
  inAppMessage: string;
};

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

export async function loadStudioWeeklyReminderState(
  db: Db,
  businessId: string,
  now = new Date(),
  deps?: {
    smsPlatformConfigured?: boolean;
  },
): Promise<StudioWeeklyReminderState> {
  const [business, settings] = await Promise.all([
    db.business.findFirst({
      where: { id: businessId },
      select: { id: true, timezone: true, operationalSmsNumber: true },
    }),
    db.businessSettings.findUnique({
      where: { businessId },
      select: { studioWeeklyReviewReminderOptedIn: true },
    }),
  ]);
  const timezone = resolveBusinessTimeZone(business);
  const weekKey = studioWeeklyReminderWeekKey(now, timezone);
  const delivery = resolveStudioWeeklyReminderDelivery({
    platformConfigured: deps?.smsPlatformConfigured,
    dedicatedNumberAssigned: Boolean(business?.operationalSmsNumber?.trim()),
  });
  const reminderRow = await db.marketingStudioWeeklyReminder.findFirst({
    where: { businessId, weekKey },
  });
  const reminder = reminderRow ? asReminder(reminderRow) : null;
  return {
    optedIn: settings?.studioWeeklyReviewReminderOptedIn === true,
    weekKey,
    timezone,
    reminder,
    delivery,
    copy: reminder ? studioWeeklyReminderCopy(reminder.awaitingCount) : null,
    inAppMessage: STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE,
  };
}

export async function setStudioWeeklyReviewReminderOptIn(
  db: Db,
  access: BusinessAccess,
  optedIn: boolean,
  now = new Date(),
  deps?: {
    smsPlatformConfigured?: boolean;
  },
) {
  requireOwnerWeeklyReminder(access);
  await db.businessSettings.upsert({
    where: { businessId: access.businessId },
    create: {
      businessId: access.businessId,
      studioWeeklyReviewReminderOptedIn: optedIn,
    },
    update: {
      studioWeeklyReviewReminderOptedIn: optedIn,
    },
  });
  const dispatch = optedIn
    ? await dispatchStudioWeeklyReviewReminder(db, access.businessId, now, deps)
    : null;
  return {
    optedIn,
    message: optedIn ? STUDIO_WEEKLY_REMINDER_OPTED_IN_MESSAGE : STUDIO_WEEKLY_REMINDER_OPTED_OUT_MESSAGE,
    dispatch,
  };
}

export async function dispatchStudioWeeklyReviewReminder(
  db: Db,
  businessId: string,
  now = new Date(),
  deps?: {
    smsPlatformConfigured?: boolean;
  },
): Promise<StudioWeeklyReminderDispatchResult> {
  const state = await loadStudioWeeklyReminderState(db, businessId, now, deps);
  const delivery = state.delivery;
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

export function studioWeeklyReminderSmsLabel(state: StudioWeeklyReminderState) {
  return state.reminder?.smsLabel || state.delivery.smsLabel || STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED;
}

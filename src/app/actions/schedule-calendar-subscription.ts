"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import {
  SCHEDULE_CALENDAR_SUBSCRIPTION_CREATED_MESSAGE,
  SCHEDULE_CALENDAR_SUBSCRIPTION_REVOKED_MESSAGE,
  SCHEDULE_CALENDAR_SUBSCRIPTION_ROTATED_MESSAGE,
  createScheduleCalendarSubscription,
  isScheduleCalendarSubscriptionScope,
  rotateScheduleCalendarSubscription,
  revokeScheduleCalendarSubscription,
  scheduleCalendarSubscriptionErrorMessage,
  type ScheduleCalendarSubscriptionScope,
} from "@/lib/schedule-calendar-subscription";

export type ScheduleCalendarSubscriptionActionState = {
  error?: string;
  message?: string;
  feedUrl?: string;
};

function readScope(formData: FormData): ScheduleCalendarSubscriptionScope | null {
  const value = formData.get("scope");
  return typeof value === "string" && isScheduleCalendarSubscriptionScope(value) ? value : null;
}

function revalidateSubscriptionSurfaces(scope: ScheduleCalendarSubscriptionScope) {
  if (scope === "business") revalidatePath("/jobs");
  if (scope === "assigned") revalidatePath("/field");
}

export async function createScheduleCalendarSubscriptionAction(
  _prev: ScheduleCalendarSubscriptionActionState,
  formData: FormData,
): Promise<ScheduleCalendarSubscriptionActionState> {
  const scope = readScope(formData);
  if (!scope) return { error: "Unknown calendar subscription scope." };
  try {
    const access = await requireBusinessAccess();
    const issued = await createScheduleCalendarSubscription(prisma, access, scope);
    revalidateSubscriptionSurfaces(scope);
    return {
      message: SCHEDULE_CALENDAR_SUBSCRIPTION_CREATED_MESSAGE,
      feedUrl: issued.feedUrl,
    };
  } catch (error) {
    return {
      error: scheduleCalendarSubscriptionErrorMessage(
        error,
        "The calendar subscription could not be created.",
      ),
    };
  }
}

export async function rotateScheduleCalendarSubscriptionAction(
  _prev: ScheduleCalendarSubscriptionActionState,
  formData: FormData,
): Promise<ScheduleCalendarSubscriptionActionState> {
  const scope = readScope(formData);
  if (!scope) return { error: "Unknown calendar subscription scope." };
  try {
    const access = await requireBusinessAccess();
    const issued = await rotateScheduleCalendarSubscription(prisma, access, scope);
    revalidateSubscriptionSurfaces(scope);
    return {
      message: SCHEDULE_CALENDAR_SUBSCRIPTION_ROTATED_MESSAGE,
      feedUrl: issued.feedUrl,
    };
  } catch (error) {
    return {
      error: scheduleCalendarSubscriptionErrorMessage(
        error,
        "The calendar subscription could not be rotated.",
      ),
    };
  }
}

export async function revokeScheduleCalendarSubscriptionAction(
  _prev: ScheduleCalendarSubscriptionActionState,
  formData: FormData,
): Promise<ScheduleCalendarSubscriptionActionState> {
  const scope = readScope(formData);
  if (!scope) return { error: "Unknown calendar subscription scope." };
  try {
    const access = await requireBusinessAccess();
    await revokeScheduleCalendarSubscription(prisma, access, scope);
    revalidateSubscriptionSurfaces(scope);
    return { message: SCHEDULE_CALENDAR_SUBSCRIPTION_REVOKED_MESSAGE };
  } catch (error) {
    return {
      error: scheduleCalendarSubscriptionErrorMessage(
        error,
        "The calendar subscription could not be revoked.",
      ),
    };
  }
}

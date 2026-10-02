import { Prisma } from "@prisma/client";

export const SCHEDULE_CALENDAR_SUBSCRIPTION_UNAVAILABLE_TABLE = "ScheduleCalendarSubscription";

export function missingScheduleCalendarSubscriptionSchema(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  if (code === "P2021" || code === "P2022") return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2021" || error.code === "P2022";
  }
  return false;
}

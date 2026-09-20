/**
 * Business calendar-day timezone.
 *
 * Vercel (and this app's production Node process) run in UTC. Using
 * `new Date()`, `getFullYear()`/`getDate()`, or `toISOString().slice(0, 10)`
 * to decide "today" advances the business date at UTC midnight — 8:00 PM
 * in America/New_York. Fort Myers, Florida uses America/New_York; that is
 * the default for every tenant unless a valid IANA timezone is stored on
 * Business.timezone.
 *
 * DST is resolved with Intl (IANA), never a hard-coded hour offset.
 * Preview shares Production and skips migrate, so reads first ensure the
 * additive column exists.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

type TimezoneClient = PrismaClient | Prisma.TransactionClient;

export const DEFAULT_BUSINESS_TIMEZONE = "America/New_York";

export const BUSINESS_TIMEZONE_ENSURE_SQL =
  `ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "timezone" TEXT`;

let ensureSchemaPromise: Promise<void> | null = null;

export function resetBusinessTimezoneSchemaEnsure() {
  ensureSchemaPromise = null;
}

export async function ensureBusinessTimezoneSchema(db: TimezoneClient) {
  if (!ensureSchemaPromise) {
    ensureSchemaPromise = (async () => {
      await db.$executeRawUnsafe(BUSINESS_TIMEZONE_ENSURE_SQL);
    })().catch((error) => {
      ensureSchemaPromise = null;
      throw error;
    });
  }
  await ensureSchemaPromise;
}

export function isValidIanaTimeZone(value: string | null | undefined): value is string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function resolveBusinessTimeZone(business: {
  timezone?: string | null;
} | null | undefined): string {
  const stored = business?.timezone?.trim();
  if (stored && isValidIanaTimeZone(stored)) return stored;
  return DEFAULT_BUSINESS_TIMEZONE;
}

export type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function readPart(parts: Intl.DateTimeFormatPart[], type: string) {
  return Number(parts.find((part) => part.type === type)?.value);
}

export function zonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return {
    year: readPart(parts, "year"),
    month: readPart(parts, "month"),
    day: readPart(parts, "day"),
    hour: readPart(parts, "hour"),
    minute: readPart(parts, "minute"),
    second: readPart(parts, "second"),
  };
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export function formatISODateInTimeZone(date: Date, timeZone: string) {
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/**
 * UTC instant of a civil wall-clock in `timeZone`. Iterates via Intl so
 * the offset at that instant (including DST) is used — never a fixed
 * hour subtraction.
 */
export function zonedCivilToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  let utc = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i += 1) {
    const parts = zonedDateParts(new Date(utc), timeZone);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const desired = Date.UTC(year, month - 1, day, hour, minute, second);
    const delta = desired - asUtc;
    if (delta === 0) break;
    utc += delta;
  }
  return new Date(utc);
}

export function startOfZonedDay(date: Date, timeZone: string) {
  const parts = zonedDateParts(date, timeZone);
  return zonedCivilToUtc(parts.year, parts.month, parts.day, 0, 0, 0, timeZone);
}

export function parseCivilDateInTimeZone(year: number, month: number, day: number, timeZone: string) {
  const instant = zonedCivilToUtc(year, month, day, 0, 0, 0, timeZone);
  const parts = zonedDateParts(instant, timeZone);
  if (parts.year !== year || parts.month !== month || parts.day !== day) {
    return null;
  }
  return instant;
}

/** Calendar-day add in `timeZone`. `setDate` on a UTC instant is not DST-safe. */
export function addZonedCalendarDays(date: Date, amount: number, timeZone: string) {
  const parts = zonedDateParts(date, timeZone);
  const civil = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  return zonedCivilToUtc(
    civil.getUTCFullYear(),
    civil.getUTCMonth() + 1,
    civil.getUTCDate(),
    0,
    0,
    0,
    timeZone,
  );
}

export function addZonedCalendarMonths(date: Date, amount: number, timeZone: string) {
  const parts = zonedDateParts(date, timeZone);
  const civil = new Date(Date.UTC(parts.year, parts.month - 1 + amount, parts.day));
  return zonedCivilToUtc(
    civil.getUTCFullYear(),
    civil.getUTCMonth() + 1,
    civil.getUTCDate(),
    0,
    0,
    0,
    timeZone,
  );
}

export function zonedWeekday(date: Date, timeZone: string) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

export function startOfZonedWeek(date: Date, timeZone: string) {
  const start = startOfZonedDay(date, timeZone);
  return addZonedCalendarDays(start, -zonedWeekday(start, timeZone), timeZone);
}

export function startOfZonedMonth(date: Date, timeZone: string) {
  const parts = zonedDateParts(date, timeZone);
  return zonedCivilToUtc(parts.year, parts.month, 1, 0, 0, 0, timeZone);
}

export function formatZonedTimeInput(date: Date, timeZone: string) {
  const parts = zonedDateParts(date, timeZone);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

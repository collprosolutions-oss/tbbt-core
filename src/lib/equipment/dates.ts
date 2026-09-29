import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { parseExpenseDate } from "@/lib/expenses";
import { formatISODate, startOfDay } from "@/lib/schedule";

export function equipmentTimeZone(access: {
  workspace?: { business?: { timezone?: string | null } | null };
}): string {
  return resolveBusinessTimeZone(access.workspace?.business);
}

export function parseEquipmentDate(
  raw: string | undefined,
  timeZone: string,
): Date | null {
  return parseExpenseDate((raw ?? "").trim(), timeZone);
}

export function requireEquipmentDate(
  raw: string | undefined,
  timeZone: string,
  label: string,
): Date {
  const parsed = parseEquipmentDate(raw, timeZone);
  if (!parsed) {
    throw new Error(`Enter a valid ${label} as YYYY-MM-DD.`);
  }
  return parsed;
}

export function optionalEquipmentDate(
  raw: string | undefined,
  timeZone: string,
  label: string,
): Date | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  return requireEquipmentDate(value, timeZone, label);
}

/**
 * Due uses the owner-recorded serviceOn only. A missing service date is
 * never due. Maintenance dates never invent a next service.
 */
export function equipmentIsDue(serviceOn: Date | null | undefined, now: Date, timeZone: string): boolean {
  if (!serviceOn) return false;
  return startOfDay(serviceOn, timeZone).getTime() <= startOfDay(now, timeZone).getTime();
}

export function formatEquipmentDate(value: Date | null | undefined, timeZone: string): string | null {
  if (!value) return null;
  return formatISODate(value, timeZone);
}

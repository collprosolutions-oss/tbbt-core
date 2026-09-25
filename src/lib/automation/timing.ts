export function parseServerScheduledAt(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function appointmentReminderAvailableAt(scheduledAt: Date, delayMinutes: number) {
  return new Date(scheduledAt.getTime() - Math.max(0, delayMinutes) * 60_000);
}

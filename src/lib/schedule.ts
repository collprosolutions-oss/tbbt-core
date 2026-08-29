/**
 * Business-wide Schedule / Jobs calendar foundation.
 *
 * The Job model (see prisma/schema.prisma) remains the ONLY source of
 * scheduled-work truth: `scheduledAt` (single start timestamp, nullable) and
 * `scheduledDurationMinutes` (optional expected duration). This module adds
 * no new persistence -- it only derives calendar ranges, groups existing
 * Jobs into those ranges, and flags overlaps using the exact same
 * `schedulesOverlap()` helper the existing scheduleJob() server action
 * already uses for its own overlap warning (see src/lib/job-schedule.ts and
 * src/app/actions/job.ts). Do not add a second scheduling data source here.
 */
import { schedulesOverlap } from "@/lib/job-schedule";

export const SCHEDULE_VIEWS = ["month", "week", "day", "crew", "list"] as const;
export type ScheduleView = (typeof SCHEDULE_VIEWS)[number];

const DEFAULT_VIEW: ScheduleView = "month";

/**
 * Safe parsing for the `view` query param (TEST 16: invalid/missing values
 * must fail safely, never throw or crash the page). Anything not in
 * SCHEDULE_VIEWS silently falls back to the default Month view.
 */
export function parseScheduleView(
  raw: string | string[] | undefined,
): ScheduleView {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (SCHEDULE_VIEWS as readonly string[]).includes(value ?? "")
    ? (value as ScheduleView)
    : DEFAULT_VIEW;
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

/** yyyy-mm-dd in the server's local time -- matches the <input type="date"> shape already used by ScheduleJobForm. */
export function formatISODate(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

export function addMonths(date: Date, amount: number) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + amount);
  return next;
}

export function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** Sunday-first week, matching the en-US calendar convention used elsewhere in this app. */
export function startOfWeek(date: Date) {
  const start = startOfDay(date);
  return addDays(start, -start.getDay());
}

/**
 * Safe parsing for the `date` query param (TEST 16). Anything that is not
 * exactly yyyy-mm-dd, or does not round-trip to a real calendar date (e.g.
 * 2026-02-30), falls back to today -- never throws, never silently produces
 * an off-by-one date via Date's normalizing constructor.
 */
export function parseScheduleDate(raw: string | string[] | undefined): Date {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const candidate = new Date(year, month - 1, day);
    if (
      candidate.getFullYear() === year &&
      candidate.getMonth() === month - 1 &&
      candidate.getDate() === day
    ) {
      return candidate;
    }
  }
  return startOfDay(new Date());
}

export type DateRange = { start: Date; end: Date };

/**
 * The exact grid shown in Month view: complete weeks (Sun-Sat) covering
 * every day of the target month, including the handful of leading/trailing
 * days from adjacent months needed to fill the grid. `start`/`end` bound
 * the ONE query Month view runs -- never the entire Job history (see the
 * PERFORMANCE section of the Phase 3 / Step 3 spec).
 */
export function monthGridRange(anchor: Date): DateRange & {
  monthStart: Date;
  monthEnd: Date;
  days: Date[];
} {
  const monthStart = startOfMonth(anchor);
  const monthEnd = startOfMonth(addMonths(anchor, 1));
  const gridStart = startOfWeek(monthStart);
  const rawDayCount = Math.round(
    (monthEnd.getTime() - gridStart.getTime()) / (24 * 60 * 60 * 1000),
  );
  const totalCells = Math.ceil(rawDayCount / 7) * 7;
  const days: Date[] = [];
  for (let i = 0; i < totalCells; i += 1) {
    days.push(addDays(gridStart, i));
  }
  return {
    start: gridStart,
    end: addDays(gridStart, totalCells),
    monthStart,
    monthEnd,
    days,
  };
}

export function weekRange(anchor: Date): DateRange & { days: Date[] } {
  const start = startOfWeek(anchor);
  const end = addDays(start, 7);
  const days: Date[] = [];
  for (let i = 0; i < 7; i += 1) {
    days.push(addDays(start, i));
  }
  return { start, end, days };
}

export function dayRange(anchor: Date): DateRange {
  const start = startOfDay(anchor);
  return { start, end: addDays(start, 1) };
}

export function monthLabel(date: Date) {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function weekLabel(range: DateRange) {
  const lastDay = addDays(range.end, -1);
  const sameMonth = range.start.getMonth() === lastDay.getMonth();
  const startLabel = range.start.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const endLabel = lastDay.toLocaleDateString("en-US", {
    month: sameMonth ? undefined : "short",
    day: "numeric",
    year: "numeric",
  });
  return `${startLabel} - ${endLabel}`;
}

export function dayLabel(date: Date) {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export type DayTone = "past" | "today" | "future";

export function dayTone(day: Date, today: Date): DayTone {
  if (isSameDay(day, today)) {
    return "today";
  }
  return startOfDay(day) < startOfDay(today) ? "past" : "future";
}

/**
 * Approved TBBT time-visual rules: past dates read muted/darker, today gets
 * soft green emphasis with dark readable text, future dates get a lighter
 * blue/navy treatment. Kept as one small lookup so every view (Month/Week/
 * Day) renders the same rule consistently.
 */
export function dayToneClasses(tone: DayTone) {
  switch (tone) {
    case "past":
      return "bg-muted/60 text-muted-foreground border-border";
    case "today":
      return "bg-green-100 text-green-950 border-green-300 dark:bg-green-950/40 dark:text-green-50 dark:border-green-800";
    case "future":
    default:
      return "bg-sky-50 text-slate-900 border-sky-100 dark:bg-slate-900/40 dark:text-slate-100 dark:border-slate-800";
  }
}

/** The minimal shape every schedule view needs to render and reason about a Job. */
export type ScheduleJob = {
  id: string;
  status: string;
  scheduledAt: Date | null;
  scheduledDurationMinutes: number | null;
  customer: { name: string } | null;
  property: {
    addressLine1: string;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
  } | null;
  approvedEstimateVersion: { lineItems: { description: string }[] } | null;
  estimate: { lineItems: { description: string }[] } | null;
};

/** The Prisma `select` shape that produces ScheduleJob above -- share this, never hand-roll a second one. */
export const SCHEDULE_JOB_SELECT = {
  id: true,
  status: true,
  scheduledAt: true,
  scheduledDurationMinutes: true,
  customer: { select: { name: true } },
  property: {
    select: {
      addressLine1: true,
      addressLine2: true,
      city: true,
      region: true,
      postalCode: true,
    },
  },
  // Only the first line item is needed for a compact scope summary; taking
  // just one keeps this bounded no matter how many line items a Job has.
  approvedEstimateVersion: {
    select: {
      lineItems: {
        take: 1,
        orderBy: { createdAt: "asc" as const },
        select: { description: true },
      },
    },
  },
  estimate: {
    select: {
      lineItems: {
        take: 1,
        orderBy: { createdAt: "asc" as const },
        select: { description: true },
      },
    },
  },
} as const;

/** Mirrors resolveApprovedWorkOrderScope()'s priority (bound version, then legacy estimate) for a one-line summary. */
export function jobScopeSummary(job: {
  approvedEstimateVersion: { lineItems: { description: string }[] } | null;
  estimate: { lineItems: { description: string }[] } | null;
}): string | null {
  const line =
    job.approvedEstimateVersion?.lineItems[0] ?? job.estimate?.lineItems[0];
  return line?.description ?? null;
}

export function groupJobsByDay<T extends { scheduledAt: Date | null }>(
  jobs: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const job of jobs) {
    if (!job.scheduledAt) {
      continue;
    }
    const key = formatISODate(job.scheduledAt);
    const existing = groups.get(key);
    if (existing) {
      existing.push(job);
    } else {
      groups.set(key, [job]);
    }
  }
  return groups;
}

/**
 * Lightweight, truthful conflict detection (see the CONFLICT DETECTION
 * section of the Phase 3 / Step 3 spec): two Jobs conflict only when their
 * known scheduledAt + scheduledDurationMinutes windows actually overlap,
 * using the exact same window math as scheduleJob()'s own overlap warning
 * (schedulesOverlap() in src/lib/job-schedule.ts). COMPLETED jobs are
 * excluded, matching that same existing rule -- a finished job cannot be in
 * conflict with anything.
 *
 * KNOWN LIMITATION (documented, not hidden): a Job with no
 * scheduledDurationMinutes is treated as a single-instant appointment (the
 * same "at least 1 minute" floor scheduleWindow() already uses), so two
 * duration-less Jobs only flag as conflicting if they start at the exact
 * same minute. This under-detects rather than fabricates a duration that
 * was never recorded -- true overlap precision for duration-less Jobs
 * should wait for real arrival-window/duration data, not be guessed here.
 */
export function findScheduleConflicts<
  T extends {
    id: string;
    status: string;
    scheduledAt: Date | null;
    scheduledDurationMinutes: number | null;
  },
>(jobs: T[]): Map<string, T[]> {
  const relevant = jobs.filter(
    (job) => job.scheduledAt && job.status !== "COMPLETED",
  );
  const conflicts = new Map<string, T[]>();
  for (let i = 0; i < relevant.length; i += 1) {
    for (let j = i + 1; j < relevant.length; j += 1) {
      const a = relevant[i];
      const b = relevant[j];
      if (
        schedulesOverlap(
          a.scheduledAt!,
          a.scheduledDurationMinutes,
          b.scheduledAt!,
          b.scheduledDurationMinutes,
        )
      ) {
        conflicts.set(a.id, [...(conflicts.get(a.id) ?? []), b]);
        conflicts.set(b.id, [...(conflicts.get(b.id) ?? []), a]);
      }
    }
  }
  return conflicts;
}

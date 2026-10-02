/**
 * Customer preferred days / time windows on a Handyman public request.
 *
 * Preview cannot add Prisma columns, so the record is encoded on
 * ServiceRequest.description after a stable marker — same pattern as
 * work-area intake. Preferences are requests, not confirmed bookings.
 * Owner approval, first exact slot, later arrival windows, and the
 * configured travel buffer stay on scheduleJob.
 */
import {
  addZonedCalendarDays,
  formatISODateInTimeZone,
  isValidIanaTimeZone,
  parseCivilDateInTimeZone,
  resolveBusinessTimeZone,
  zonedCivilToUtc,
} from "@/lib/business-timezone";

export const PREFERRED_WINDOWS_MARKER = "\n\nTBBT Preferred Windows:\n";
export const MAX_REQUEST_PREFERRED_WINDOWS = 3;
export const PREFERRED_WINDOWS_VERSION = 1;

export const PREFERRED_WINDOWS_HANDYMAN_ONLY_MESSAGE =
  "Preferred days or time windows can only be added on a Handyman request.";
export const PREFERRED_WINDOWS_TOO_MANY_MESSAGE =
  "Choose up to three preferred days or time windows.";
export const PREFERRED_WINDOWS_INVALID_MESSAGE =
  "Enter a valid preferred day or time window.";
export const PREFERRED_WINDOWS_EXPIRED_MESSAGE =
  "Preferred days or time windows must still be in the future.";
export const PREFERRED_WINDOWS_STALE_MESSAGE =
  "Those customer preferences are no longer current. They are not a confirmed booking.";
export const PREFERRED_WINDOWS_NOT_A_BOOKING =
  "Customer preferences are requests, not confirmed bookings. The owner still chooses and approves the appointment.";

export const PREFERRED_WINDOW_KINDS = ["DAY", "WINDOW"] as const;
export type PreferredWindowKind = (typeof PREFERRED_WINDOW_KINDS)[number];

export type PreferredWindowDraft = {
  kind: PreferredWindowKind;
  localDate: string;
  startLocal?: string;
  endLocal?: string;
};

export type StoredPreferredWindow = {
  id: string;
  kind: PreferredWindowKind;
  localDate: string;
  startLocal: string | null;
  endLocal: string | null;
  startAt: string;
  endAt: string;
};

export type PreferredWindowsRecord = {
  version: typeof PREFERRED_WINDOWS_VERSION;
  timeZone: string;
  windows: StoredPreferredWindow[];
};

export type OwnerPreferredWindowView = {
  id: string;
  kind: PreferredWindowKind;
  status: "current" | "expired";
  label: string;
  localDate: string;
  startLocal: string | null;
  endLocal: string | null;
};

export type OwnerPreferredWindowsView = {
  timeZone: string;
  fingerprint: string;
  notABooking: string;
  windows: OwnerPreferredWindowView[];
};

export const preferredWindowsTestHooks: {
  now?: () => Date;
} = {};

function currentNow() {
  return preferredWindowsTestHooks.now?.() ?? new Date();
}

function isPreferredWindowKind(value: unknown): value is PreferredWindowKind {
  return PREFERRED_WINDOW_KINDS.includes(value as PreferredWindowKind);
}

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CIVIL_TIME = /^(\d{2}):(\d{2})$/;

export function parseCivilDateParts(value: string) {
  const match = CIVIL_DATE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  return { year, month, day };
}

export function parseCivilTimeParts(value: string) {
  const match = CIVIL_TIME.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return { hour, minute };
}

function encodedBlockAfter(description: string | null | undefined, marker: string) {
  const raw = description ?? "";
  const index = raw.indexOf(marker);
  if (index === -1) return "";
  let rest = raw.slice(index + marker.length).trim();
  const nextMarker = rest.search(/\n\nTBBT /);
  if (nextMarker !== -1) rest = rest.slice(0, nextMarker).trim();
  return rest;
}

export function parsePreferredWindowsRecord(raw: unknown): PreferredWindowsRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (item.version !== PREFERRED_WINDOWS_VERSION) return null;
  if (!isValidIanaTimeZone(typeof item.timeZone === "string" ? item.timeZone : "")) {
    return null;
  }
  if (!Array.isArray(item.windows) || item.windows.length > MAX_REQUEST_PREFERRED_WINDOWS) {
    return null;
  }
  const windows: StoredPreferredWindow[] = [];
  for (const row of item.windows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const window = row as Record<string, unknown>;
    if (typeof window.id !== "string" || !window.id.trim()) return null;
    if (!isPreferredWindowKind(window.kind)) return null;
    if (typeof window.localDate !== "string" || !parseCivilDateParts(window.localDate)) {
      return null;
    }
    if (typeof window.startAt !== "string" || Number.isNaN(Date.parse(window.startAt))) {
      return null;
    }
    if (typeof window.endAt !== "string" || Number.isNaN(Date.parse(window.endAt))) {
      return null;
    }
    const startLocal =
      window.startLocal == null
        ? null
        : typeof window.startLocal === "string" && parseCivilTimeParts(window.startLocal)
          ? window.startLocal
          : null;
    const endLocal =
      window.endLocal == null
        ? null
        : typeof window.endLocal === "string" && parseCivilTimeParts(window.endLocal)
          ? window.endLocal
          : null;
    if (window.kind === "WINDOW" && (!startLocal || !endLocal)) return null;
    windows.push({
      id: window.id.trim(),
      kind: window.kind,
      localDate: window.localDate,
      startLocal: window.kind === "DAY" ? null : startLocal,
      endLocal: window.kind === "DAY" ? null : endLocal,
      startAt: new Date(window.startAt).toISOString(),
      endAt: new Date(window.endAt).toISOString(),
    });
  }
  return {
    version: PREFERRED_WINDOWS_VERSION,
    timeZone: item.timeZone as string,
    windows,
  };
}

export function parsePreferredWindowsFromDescription(
  description?: string | null,
): PreferredWindowsRecord | null {
  const block = encodedBlockAfter(description, PREFERRED_WINDOWS_MARKER);
  if (!block) return null;
  try {
    return parsePreferredWindowsRecord(JSON.parse(block));
  } catch {
    return null;
  }
}

export function appendPreferredWindowsToDescription(
  description: string | null | undefined,
  record: PreferredWindowsRecord | null,
): string | null {
  const raw = description ?? "";
  const index = raw.indexOf(PREFERRED_WINDOWS_MARKER);
  const base = (index === -1 ? raw : raw.slice(0, index)).replace(/\s+$/, "");
  if (!record || record.windows.length === 0) return base || null;
  return `${base}${PREFERRED_WINDOWS_MARKER}${JSON.stringify(record)}`;
}

export function preferredWindowsFingerprint(record: PreferredWindowsRecord) {
  return JSON.stringify({
    version: record.version,
    timeZone: record.timeZone,
    windows: record.windows.map((window) => ({
      id: window.id,
      kind: window.kind,
      localDate: window.localDate,
      startLocal: window.startLocal,
      endLocal: window.endLocal,
      startAt: window.startAt,
      endAt: window.endAt,
    })),
  });
}

function windowInstants(input: {
  kind: PreferredWindowKind;
  localDate: string;
  startLocal?: string;
  endLocal?: string;
  timeZone: string;
}): { startAt: Date; endAt: Date; startLocal: string | null; endLocal: string | null } | null {
  const dateParts = parseCivilDateParts(input.localDate);
  if (!dateParts) return null;
  const startOfDay = parseCivilDateInTimeZone(
    dateParts.year,
    dateParts.month,
    dateParts.day,
    input.timeZone,
  );
  if (!startOfDay) return null;

  if (input.kind === "DAY") {
    return {
      startAt: startOfDay,
      endAt: addZonedCalendarDays(startOfDay, 1, input.timeZone),
      startLocal: null,
      endLocal: null,
    };
  }

  const startParts = parseCivilTimeParts(input.startLocal ?? "");
  const endParts = parseCivilTimeParts(input.endLocal ?? "");
  if (!startParts || !endParts) return null;
  const startAt = zonedCivilToUtc(
    dateParts.year,
    dateParts.month,
    dateParts.day,
    startParts.hour,
    startParts.minute,
    0,
    input.timeZone,
  );
  const endAt = zonedCivilToUtc(
    dateParts.year,
    dateParts.month,
    dateParts.day,
    endParts.hour,
    endParts.minute,
    0,
    input.timeZone,
  );
  if (endAt.getTime() <= startAt.getTime()) return null;
  if (formatISODateInTimeZone(startAt, input.timeZone) !== input.localDate) return null;
  if (formatISODateInTimeZone(endAt, input.timeZone) !== input.localDate) return null;
  return {
    startAt,
    endAt,
    startLocal: `${String(startParts.hour).padStart(2, "0")}:${String(startParts.minute).padStart(2, "0")}`,
    endLocal: `${String(endParts.hour).padStart(2, "0")}:${String(endParts.minute).padStart(2, "0")}`,
  };
}

export function normalizePreferredWindowsInput(input: {
  drafts?: unknown;
  /** Ignored. Windows are stored in the business timezone only. */
  timeZone?: string | null;
  business?: { timezone?: string | null } | null;
  tradeCode?: string | null;
  now?: Date;
}):
  | { ok: true; record: PreferredWindowsRecord | null }
  | { ok: false; error: string } {
  const drafts = Array.isArray(input.drafts) ? input.drafts : [];
  if (drafts.length === 0) return { ok: true, record: null };
  if ((input.tradeCode ?? "").trim() !== "HANDYMAN") {
    return { ok: false, error: PREFERRED_WINDOWS_HANDYMAN_ONLY_MESSAGE };
  }
  if (drafts.length > MAX_REQUEST_PREFERRED_WINDOWS) {
    return { ok: false, error: PREFERRED_WINDOWS_TOO_MANY_MESSAGE };
  }
  void input.timeZone;

  const timeZone = resolveBusinessTimeZone(input.business);
  const now = input.now ?? currentNow();
  const windows: StoredPreferredWindow[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of drafts.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: PREFERRED_WINDOWS_INVALID_MESSAGE };
    }
    const draft = raw as Record<string, unknown>;
    if (!isPreferredWindowKind(draft.kind)) {
      return { ok: false, error: PREFERRED_WINDOWS_INVALID_MESSAGE };
    }
    if (typeof draft.localDate !== "string") {
      return { ok: false, error: PREFERRED_WINDOWS_INVALID_MESSAGE };
    }
    const instants = windowInstants({
      kind: draft.kind,
      localDate: draft.localDate,
      startLocal: typeof draft.startLocal === "string" ? draft.startLocal : undefined,
      endLocal: typeof draft.endLocal === "string" ? draft.endLocal : undefined,
      timeZone,
    });
    if (!instants) {
      return { ok: false, error: PREFERRED_WINDOWS_INVALID_MESSAGE };
    }
    if (instants.endAt.getTime() <= now.getTime()) {
      return { ok: false, error: PREFERRED_WINDOWS_EXPIRED_MESSAGE };
    }
    const key = `${draft.kind}:${instants.startAt.toISOString()}:${instants.endAt.toISOString()}`;
    if (seen.has(key)) {
      return { ok: false, error: PREFERRED_WINDOWS_INVALID_MESSAGE };
    }
    seen.add(key);
    windows.push({
      id: `pref-${index + 1}`,
      kind: draft.kind,
      localDate: draft.localDate.trim(),
      startLocal: instants.startLocal,
      endLocal: instants.endLocal,
      startAt: instants.startAt.toISOString(),
      endAt: instants.endAt.toISOString(),
    });
  }

  return {
    ok: true,
    record: {
      version: PREFERRED_WINDOWS_VERSION,
      timeZone,
      windows,
    },
  };
}

export function parsePreferredWindowDrafts(raw: unknown): PreferredWindowDraft[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const draft = item as Record<string, unknown>;
    if (!isPreferredWindowKind(draft.kind) || typeof draft.localDate !== "string") {
      return [];
    }
    return [
      {
        kind: draft.kind,
        localDate: draft.localDate,
        startLocal: typeof draft.startLocal === "string" ? draft.startLocal : "",
        endLocal: typeof draft.endLocal === "string" ? draft.endLocal : "",
      },
    ];
  });
}

function formatClock(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(date);
}

function formatDayLabel(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  }).format(date);
}

export function preferredWindowIsExpired(
  window: Pick<StoredPreferredWindow, "endAt">,
  now = currentNow(),
) {
  return new Date(window.endAt).getTime() <= now.getTime();
}

export function ownerPreferredWindowLabel(
  window: StoredPreferredWindow,
  timeZone: string,
) {
  const start = new Date(window.startAt);
  const day = formatDayLabel(start, timeZone);
  if (window.kind === "DAY") {
    return `${day} (all day)`;
  }
  return `${day} · ${formatClock(start, timeZone)}–${formatClock(new Date(window.endAt), timeZone)}`;
}

export function ownerPreferredWindowsView(
  record: PreferredWindowsRecord | null,
  now = currentNow(),
): OwnerPreferredWindowsView | null {
  if (!record || record.windows.length === 0) return null;
  return {
    timeZone: record.timeZone,
    fingerprint: preferredWindowsFingerprint(record),
    notABooking: PREFERRED_WINDOWS_NOT_A_BOOKING,
    windows: record.windows.map((window) => {
      const expired = preferredWindowIsExpired(window, now);
      return {
        id: window.id,
        kind: window.kind,
        status: expired ? "expired" : "current",
        label: expired
          ? `Expired — ${ownerPreferredWindowLabel(window, record.timeZone)}`
          : ownerPreferredWindowLabel(window, record.timeZone),
        localDate: window.localDate,
        startLocal: window.startLocal,
        endLocal: window.endLocal,
      };
    }),
  };
}

export function ownerPreferredWindowsFromDescription(
  description?: string | null,
  now = currentNow(),
) {
  return ownerPreferredWindowsView(parsePreferredWindowsFromDescription(description), now);
}

export function applyPreferredWindowForScheduling(input: {
  record: PreferredWindowsRecord | null;
  windowId: string;
  fingerprint: string;
  now?: Date;
}):
  | { ok: true; date: string; time: string; kind: PreferredWindowKind }
  | { ok: false; error: string } {
  if (!input.record || preferredWindowsFingerprint(input.record) !== input.fingerprint) {
    return { ok: false, error: PREFERRED_WINDOWS_STALE_MESSAGE };
  }
  const window = input.record.windows.find((row) => row.id === input.windowId);
  if (!window) {
    return { ok: false, error: PREFERRED_WINDOWS_STALE_MESSAGE };
  }
  if (preferredWindowIsExpired(window, input.now ?? currentNow())) {
    return { ok: false, error: PREFERRED_WINDOWS_EXPIRED_MESSAGE };
  }
  return {
    ok: true,
    date: window.localDate,
    time: window.kind === "WINDOW" ? (window.startLocal ?? "") : "",
    kind: window.kind,
  };
}

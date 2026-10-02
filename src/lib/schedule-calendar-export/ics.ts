import { zonedDateParts } from "@/lib/business-timezone";
import {
  SCHEDULE_CALENDAR_EXPORT_PRODID,
  type ScheduleCalendarExportEvent,
  type ScheduleCalendarExportScope,
} from "@/lib/schedule-calendar-export/contract";

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export function formatIcsUtcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function formatIcsLocalStamp(date: Date, timeZone: string): string {
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}${pad2(parts.month)}${pad2(parts.day)}T${pad2(parts.hour)}${pad2(parts.minute)}${pad2(parts.second)}`;
}

export function formatIcsLocalDisplay(date: Date, timeZone: string): string {
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)} ${timeZone}`;
}

export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function octetLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function foldIcsLine(line: string): string {
  if (octetLength(line) <= 75) return line;
  const bytes = new TextEncoder().encode(line);
  const chunks: string[] = [];
  let offset = 0;
  let limit = 75;
  while (offset < bytes.length) {
    let end = Math.min(offset + limit, bytes.length);
    while (end > offset && (bytes[end] & 0b11000000) === 0b10000000) {
      end -= 1;
    }
    chunks.push(new TextDecoder().decode(bytes.slice(offset, end)));
    offset = end;
    limit = 74;
  }
  return chunks.join("\r\n ");
}

function icsLine(name: string, value: string): string {
  return foldIcsLine(`${name}:${value}`);
}

export function eventUid(jobId: string): string {
  return `tbbt-job-${jobId}@tbbt`;
}

function eventDescription(event: ScheduleCalendarExportEvent): string {
  return [
    `Job ID: ${event.jobId}`,
    `Status: ${event.status}`,
    `Recorded start: ${formatIcsLocalDisplay(event.start, event.timeZone)}`,
    `Recorded window end: ${formatIcsLocalDisplay(event.end, event.timeZone)}`,
    `Assignment: ${event.assigned ? "currently assigned" : "unassigned"}`,
  ].join("\n");
}

export function isCancelledCalendarStatus(status: string): boolean {
  return status === "CANCELLED" || status === "CANCELED";
}

export function serializeScheduleCalendarIcs(input: {
  timeZone: string;
  scope: ScheduleCalendarExportScope;
  generatedAt: Date;
  truncated: boolean;
  events: readonly ScheduleCalendarExportEvent[];
  liveFeed?: boolean;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    icsLine("PRODID", SCHEDULE_CALENDAR_EXPORT_PRODID),
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    icsLine("X-WR-TIMEZONE", input.timeZone),
    icsLine(
      "X-WR-CALNAME",
      input.scope === "business" ? "TBBT business schedule" : "TBBT assigned jobs",
    ),
    icsLine("X-TBBT-SCOPE", input.scope),
    icsLine("X-TBBT-TIMEZONE", input.timeZone),
    icsLine("X-TBBT-TRUNCATED", input.truncated ? "TRUE" : "FALSE"),
    icsLine("X-TBBT-PUBLIC-SUBSCRIPTION", "FALSE"),
    icsLine("X-TBBT-LIVE-FEED", input.liveFeed ? "TRUE" : "FALSE"),
  ];

  for (const event of input.events) {
    const tzid = event.timeZone;
    const cancelled = isCancelledCalendarStatus(event.status);
    lines.push(
      "BEGIN:VEVENT",
      icsLine("UID", eventUid(event.jobId)),
      icsLine("DTSTAMP", formatIcsUtcStamp(input.generatedAt)),
      icsLine("DTSTART", formatIcsUtcStamp(event.start)),
      icsLine("DTEND", formatIcsUtcStamp(event.end)),
      icsLine("SUMMARY", escapeIcsText(`Job ${event.jobId}`)),
      icsLine("DESCRIPTION", escapeIcsText(eventDescription(event))),
      icsLine("STATUS", cancelled ? "CANCELLED" : "CONFIRMED"),
      icsLine("X-TBBT-JOB-ID", event.jobId),
      icsLine("X-TBBT-JOB-STATUS", event.status),
      icsLine("X-TBBT-ASSIGNED", event.assigned ? "TRUE" : "FALSE"),
      icsLine("X-TBBT-TZID", tzid),
      icsLine("X-TBBT-LOCAL-START", formatIcsLocalDisplay(event.start, tzid)),
      icsLine("X-TBBT-LOCAL-END", formatIcsLocalDisplay(event.end, tzid)),
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

export type ParsedScheduleCalendarEvent = {
  uid: string;
  jobId: string;
  status: string;
  icsStatus: string | null;
  assigned: boolean;
  tzid: string | null;
  dtstartUtc: string | null;
  dtendUtc: string | null;
  localStart: string | null;
  localEnd: string | null;
  summary: string | null;
  description: string | null;
};

export type ParsedScheduleCalendarIcs = {
  timeZone: string | null;
  scope: string | null;
  truncated: boolean;
  publicSubscription: boolean;
  liveFeed: boolean;
  events: ParsedScheduleCalendarEvent[];
};

function unfoldIcs(ics: string): string[] {
  const raw = ics.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

export function parseScheduleCalendarIcs(ics: string): ParsedScheduleCalendarIcs {
  const parsed: ParsedScheduleCalendarIcs = {
    timeZone: null,
    scope: null,
    truncated: false,
    publicSubscription: false,
    liveFeed: false,
    events: [],
  };
  let current: ParsedScheduleCalendarEvent | null = null;

  for (const line of unfoldIcs(ics)) {
    const split = line.indexOf(":");
    if (split < 0) continue;
    const name = line.slice(0, split);
    const value = line.slice(split + 1);
    if (name === "BEGIN" && value === "VEVENT") {
      current = {
        uid: "",
        jobId: "",
        status: "",
        icsStatus: null,
        assigned: false,
        tzid: null,
        dtstartUtc: null,
        dtendUtc: null,
        localStart: null,
        localEnd: null,
        summary: null,
        description: null,
      };
      continue;
    }
    if (name === "END" && value === "VEVENT" && current) {
      parsed.events.push(current);
      current = null;
      continue;
    }
    if (name === "X-WR-TIMEZONE" || name === "X-TBBT-TIMEZONE") {
      parsed.timeZone = value;
      continue;
    }
    if (name === "X-TBBT-SCOPE") {
      parsed.scope = value;
      continue;
    }
    if (name === "X-TBBT-TRUNCATED") {
      parsed.truncated = value === "TRUE";
      continue;
    }
    if (name === "X-TBBT-PUBLIC-SUBSCRIPTION") {
      parsed.publicSubscription = value === "TRUE";
      continue;
    }
    if (name === "X-TBBT-LIVE-FEED") {
      parsed.liveFeed = value === "TRUE";
      continue;
    }
    if (!current) continue;
    if (name === "UID") current.uid = value;
    if (name === "SUMMARY") current.summary = unescapeIcsText(value);
    if (name === "DESCRIPTION") current.description = unescapeIcsText(value);
    if (name === "X-TBBT-JOB-ID") current.jobId = value;
    if (name === "STATUS") current.icsStatus = value;
    if (name === "X-TBBT-JOB-STATUS") current.status = value;
    if (name === "X-TBBT-ASSIGNED") current.assigned = value === "TRUE";
    if (name === "X-TBBT-TZID") current.tzid = value;
    if (name === "X-TBBT-LOCAL-START") current.localStart = value;
    if (name === "X-TBBT-LOCAL-END") current.localEnd = value;
    if (name === "DTSTART") current.dtstartUtc = value;
    if (name === "DTEND") current.dtendUtc = value;
  }

  return parsed;
}

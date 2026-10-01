import type { MembershipRole } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import type { ScheduleCalendarExportScope } from "@/lib/schedule-calendar-export/contract";

export class ScheduleCalendarExportError extends Error {
  readonly status: number;
  readonly code: "FORBIDDEN" | "INVALID";

  constructor(
    code: ScheduleCalendarExportError["code"],
    message: string,
    status = code === "FORBIDDEN" ? 403 : 400,
  ) {
    super(message);
    this.name = "ScheduleCalendarExportError";
    this.code = code;
    this.status = status;
  }
}

function membershipIsActive(access: BusinessAccess): boolean {
  return access.workspace.membership.active === true;
}

export function canDownloadBusinessScheduleCalendar(
  role: MembershipRole,
  active = true,
): boolean {
  return role === "OWNER" && active;
}

export function canDownloadAssignedScheduleCalendar(access: BusinessAccess): boolean {
  return membershipIsActive(access);
}

export function assertCanDownloadBusinessScheduleCalendar(access: BusinessAccess): void {
  if (!canDownloadBusinessScheduleCalendar(access.workspace.role, membershipIsActive(access))) {
    throw new ForbiddenError();
  }
  requireBusinessRole(access, "OWNER");
}

export function assertCanDownloadAssignedScheduleCalendar(access: BusinessAccess): void {
  if (!canDownloadAssignedScheduleCalendar(access)) {
    throw new ForbiddenError();
  }
}

export function assertScheduleCalendarExportScope(
  access: BusinessAccess,
  scope: ScheduleCalendarExportScope,
): void {
  if (scope === "business") {
    assertCanDownloadBusinessScheduleCalendar(access);
    return;
  }
  if (scope === "assigned") {
    assertCanDownloadAssignedScheduleCalendar(access);
    return;
  }
  throw new ScheduleCalendarExportError("INVALID", "Unknown calendar download scope.");
}

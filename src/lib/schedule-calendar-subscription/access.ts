import type { MembershipRole } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import { canDownloadBusinessScheduleCalendar } from "@/lib/schedule-calendar-export/access";
import type { ScheduleCalendarSubscriptionScope } from "@/lib/schedule-calendar-subscription/contract";

export function canManageBusinessScheduleCalendarSubscription(
  role: MembershipRole,
  active = true,
): boolean {
  return canDownloadBusinessScheduleCalendar(role, active);
}

export function canManageAssignedScheduleCalendarSubscription(access: {
  workspace: { membership: { active: boolean } };
}): boolean {
  return access.workspace.membership.active === true;
}

export function assertCanManageBusinessScheduleCalendarSubscription(
  access: BusinessAccess,
): void {
  if (
    !canManageBusinessScheduleCalendarSubscription(
      access.workspace.role,
      access.workspace.membership.active === true,
    )
  ) {
    throw new ForbiddenError();
  }
  requireBusinessRole(access, "OWNER");
}

export function assertCanManageAssignedScheduleCalendarSubscription(
  access: BusinessAccess,
): void {
  if (!canManageAssignedScheduleCalendarSubscription(access)) {
    throw new ForbiddenError();
  }
}

export function assertCanManageScheduleCalendarSubscription(
  access: BusinessAccess,
  scope: ScheduleCalendarSubscriptionScope,
): void {
  if (scope === "business") {
    assertCanManageBusinessScheduleCalendarSubscription(access);
    return;
  }
  assertCanManageAssignedScheduleCalendarSubscription(access);
}

export function liveScheduleCalendarAccessAllowed(input: {
  role: MembershipRole;
  active: boolean;
  scope: ScheduleCalendarSubscriptionScope;
  membershipBusinessId: string;
  subscriptionBusinessId: string;
}): boolean {
  if (!input.active) return false;
  if (input.membershipBusinessId !== input.subscriptionBusinessId) return false;
  if (input.scope === "business") {
    return input.role === "OWNER";
  }
  return true;
}

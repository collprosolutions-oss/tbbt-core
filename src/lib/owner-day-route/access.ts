import type { MembershipRole } from "@prisma/client";
import { ForbiddenError, canAccessManagementConsole } from "@/lib/authorization";

export type OwnerDayRouteAccess = {
  businessId?: string;
  role?: MembershipRole;
  workspace?: { role: MembershipRole };
};

function roleFromAccess(access: OwnerDayRouteAccess): MembershipRole | null {
  return access.workspace?.role ?? access.role ?? null;
}

/**
 * Management/office only. MEMBER must not receive the whole-day route
 * of every scheduled job. Missing role fails closed.
 */
export function requireOwnerDayRouteAccess(access: OwnerDayRouteAccess): void {
  const role = roleFromAccess(access);
  if (!role || !canAccessManagementConsole(role)) {
    throw new ForbiddenError();
  }
}

export function ownerDayRouteRoleAllowed(role: MembershipRole): boolean {
  return canAccessManagementConsole(role);
}

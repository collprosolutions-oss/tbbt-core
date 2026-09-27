import type { MembershipRole } from "@prisma/client";
import { ForbiddenError, canAccessManagementConsole } from "@/lib/authorization";

export type RetentionAccess = {
  businessId?: string;
  role?: MembershipRole;
  workspace?: { role: MembershipRole };
};

function roleFromAccess(access: RetentionAccess): MembershipRole | null {
  return access.workspace?.role ?? access.role ?? null;
}

/**
 * Management/office only. MEMBER must not receive whole-customer
 * retention history. Missing role fails closed.
 */
export function requireRetentionCenterAccess(access: RetentionAccess): void {
  const role = roleFromAccess(access);
  if (!role || !canAccessManagementConsole(role)) {
    throw new ForbiddenError();
  }
}

export function retentionCenterRoleAllowed(role: MembershipRole): boolean {
  return canAccessManagementConsole(role);
}

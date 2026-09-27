import type { MembershipRole } from "@prisma/client";
import { ForbiddenError, canAccessManagementConsole } from "@/lib/authorization";

export type RetentionAccess = {
  businessId: string;
  workspace: { role: MembershipRole };
};

/**
 * Management/office only. MEMBER must not receive whole-customer
 * retention history.
 */
export function requireRetentionCenterAccess(access: RetentionAccess): void {
  if (!canAccessManagementConsole(access.workspace.role)) {
    throw new ForbiddenError();
  }
}

export function retentionCenterRoleAllowed(role: MembershipRole): boolean {
  return canAccessManagementConsole(role);
}

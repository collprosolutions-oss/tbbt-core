import type { MembershipRole } from "@prisma/client";
import { ForbiddenError, canAccessManagementConsole } from "@/lib/authorization";

export type DirectoryAccess = {
  businessId?: string;
  role?: MembershipRole;
  workspace?: { role: MembershipRole; membership?: { id: string } };
};

function roleFromAccess(access: DirectoryAccess): MembershipRole | null {
  return access.workspace?.role ?? access.role ?? null;
}

/**
 * Owner/admin only. MEMBER must not read or mutate the directory.
 * Missing role fails closed.
 */
export function requirePartnerVendorDirectoryAccess(access: DirectoryAccess): void {
  const role = roleFromAccess(access);
  if (!role || !canAccessManagementConsole(role)) {
    throw new ForbiddenError();
  }
}

export function partnerVendorDirectoryRoleAllowed(role: MembershipRole): boolean {
  return canAccessManagementConsole(role);
}

export function directoryActorMembershipId(access: DirectoryAccess): string {
  const membershipId = access.workspace?.membership?.id?.trim();
  if (!membershipId) {
    throw new ForbiddenError();
  }
  return membershipId;
}

import type { MembershipRole } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  ForbiddenError,
  canAccessManagementConsole,
  requireBusinessCapability,
  requireBusinessRole,
} from "@/lib/authorization";

export type CollectionsAccess = {
  businessId?: string;
  role?: MembershipRole;
  workspace?: { role: MembershipRole };
};

function roleFromAccess(access: CollectionsAccess): MembershipRole | null {
  return access.workspace?.role ?? access.role ?? null;
}

export function collectionsWorklistReadAllowed(role: MembershipRole): boolean {
  return role === "OWNER";
}

export function collectionsWorklistWriteAllowed(role: MembershipRole): boolean {
  return role === "OWNER";
}

export function assertCanReadCollectionsWorklist(access: BusinessAccess): void {
  if (!canAccessManagementConsole(access.workspace.role)) {
    throw new ForbiddenError();
  }
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);
  requireBusinessRole(access, "OWNER");
}

export function requireCollectionsWorklistWrite(access: CollectionsAccess): void {
  const role = roleFromAccess(access);
  if (role !== "OWNER") {
    throw new ForbiddenError();
  }
}

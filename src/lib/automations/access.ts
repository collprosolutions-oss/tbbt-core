import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  requireBusinessCapability,
  roleHasCapability,
} from "@/lib/authorization";

export function requireAutomationCenterAccess(access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
}

export function canManageAutomationCenter(access: Pick<BusinessAccess, "workspace">) {
  return roleHasCapability(access.workspace.role, CAPABILITIES.MANAGE_SETTINGS);
}

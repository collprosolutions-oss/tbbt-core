import type { MembershipRole } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  requireBusinessRole,
  roleHasCapability,
} from "@/lib/authorization";

export function canReadEquipmentRegister(role: MembershipRole): boolean {
  return roleHasCapability(role, CAPABILITIES.MANAGE_EQUIPMENT);
}

export function canWriteEquipmentRegister(role: MembershipRole): boolean {
  return role === "OWNER";
}

export function requireEquipmentRead(access: BusinessAccess): void {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_EQUIPMENT);
}

export function requireEquipmentWrite(access: BusinessAccess): void {
  requireEquipmentRead(access);
  requireBusinessRole(access, "OWNER");
}

export function equipmentActorMembershipId(access: BusinessAccess): string {
  const membershipId = access.workspace.membership?.id?.trim();
  if (!membershipId) {
    throw new ForbiddenError();
  }
  return membershipId;
}

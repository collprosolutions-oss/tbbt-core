import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  AccountSecurityError,
  requireSensitiveActionProof,
} from "@/lib/account-security";
import {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  requireBusinessRole,
} from "@/lib/authorization";
import { writeSettingsAuditLog } from "@/lib/settings-ops";

export const OWNERSHIP_TRANSFER_CONFIRMATION = "TRANSFER";

export class OwnershipTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnershipTransferError";
  }
}

function actorUserId(access: BusinessAccess) {
  return access.workspace.user?.id ?? access.workspace.membership.userId;
}

export async function transferBusinessOwnershipOp(
  prisma: PrismaClient,
  access: BusinessAccess,
  input: {
    targetMembershipId: string;
    confirmation: string;
    currentPassword: string;
    totpOrBackupCode?: string;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.TRANSFER_OWNERSHIP);
  requireBusinessRole(access, "OWNER");

  const userId = actorUserId(access);
  if (!userId) {
    throw new OwnershipTransferError("You need to sign in again.");
  }
  try {
    await requireSensitiveActionProof(prisma, userId, {
      password: input.currentPassword,
      totpOrBackupCode: input.totpOrBackupCode,
    });
  } catch (error) {
    if (error instanceof AccountSecurityError) {
      throw new OwnershipTransferError(error.message);
    }
    throw error;
  }

  if (input.confirmation.trim().toUpperCase() !== OWNERSHIP_TRANSFER_CONFIRMATION) {
    throw new OwnershipTransferError(
      `Type ${OWNERSHIP_TRANSFER_CONFIRMATION} to confirm the ownership transfer.`,
    );
  }

  const current = await prisma.membership.findFirst({
    where: {
      id: access.workspace.membership.id,
      businessId: access.businessId,
      role: "OWNER",
      active: true,
    },
  });
  if (!current) {
    throw new ForbiddenError();
  }

  if (input.targetMembershipId === current.id) {
    throw new OwnershipTransferError("Choose a different active OWNER or ADMIN.");
  }

  const target = await prisma.membership.findFirst({
    where: {
      id: input.targetMembershipId,
      businessId: access.businessId,
      active: true,
      role: { in: ["OWNER", "ADMIN"] },
    },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!target) {
    throw new OwnershipTransferError(
      "Ownership can only move to another active OWNER or ADMIN on this business.",
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.update({
      where: { id: current.id },
      data: { role: "ADMIN" },
    });
    await tx.membership.update({
      where: { id: target.id },
      data: { role: "OWNER" },
    });
    await writeSettingsAuditLog(tx, {
      businessId: access.businessId,
      changedByMembershipId: current.id,
      settingArea: "security",
      settingKey: "ownership",
      previousValue: { ownerMembershipId: current.id },
      newValue: {
        ownerMembershipId: target.id,
        previousOwnerNow: "ADMIN",
      },
    });
  });

  return {
    previousOwnerMembershipId: current.id,
    newOwnerMembershipId: target.id,
    newOwnerName: target.user.name,
    newOwnerEmail: target.user.email,
  };
}

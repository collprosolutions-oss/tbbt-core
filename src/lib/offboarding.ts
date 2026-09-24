import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  requireBusinessCapability,
  requireBusinessRole,
} from "@/lib/authorization";
import { writeSettingsAuditLog } from "@/lib/settings-ops";

export const OFFBOARDING_CONFIRMATION = "CANCEL";

export const OFFBOARDING_PRESERVE_MESSAGE =
  "Cancellation does not delete customers, jobs, invoices, payments, expenses, time cards, or other historical records. Download a business export first.";

export class OffboardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OffboardingError";
  }
}

export async function requestBusinessOffboardingOp(
  prisma: PrismaClient,
  access: BusinessAccess,
  input: {
    confirmation: string;
    acknowledgedExport: boolean;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.REQUEST_OFFBOARDING);
  requireBusinessRole(access, "OWNER");

  if (!input.acknowledgedExport) {
    throw new OffboardingError(
      "Confirm that you downloaded or no longer need a business data export. Records are not deleted.",
    );
  }
  if (input.confirmation.trim().toUpperCase() !== OFFBOARDING_CONFIRMATION) {
    throw new OffboardingError(
      `Type ${OFFBOARDING_CONFIRMATION} to request cancellation. Historical records stay on file.`,
    );
  }

  const business = await prisma.business.findUnique({
    where: { id: access.businessId },
    include: { saasSubscription: true },
  });
  if (!business) {
    throw new OffboardingError("That business could not be found.");
  }

  const requestedAt = business.offboardingRequestedAt ?? new Date();

  await prisma.$transaction(async (tx) => {
    await tx.business.update({
      where: { id: access.businessId },
      data: { offboardingRequestedAt: requestedAt },
    });
    if (business.saasSubscription && !business.saasSubscription.cancelAtPeriodEnd) {
      await tx.businessSaasSubscription.update({
        where: { id: business.saasSubscription.id },
        data: { cancelAtPeriodEnd: true },
      });
    }
    await writeSettingsAuditLog(tx, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "data-export",
      settingKey: "offboardingRequestedAt",
      previousValue: business.offboardingRequestedAt,
      newValue: requestedAt,
    });
  });

  return {
    requestedAt,
    recordsDeleted: false,
    cancelAtPeriodEnd: true,
  };
}

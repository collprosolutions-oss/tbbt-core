import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  AccountSecurityError,
  requireSensitiveActionProof,
} from "@/lib/account-security";
import {
  CAPABILITIES,
  requireBusinessCapability,
  requireBusinessRole,
} from "@/lib/authorization";
import { getSaasBillingProvider } from "@/lib/saas-billing/provider";
import type { SaasBillingProvider } from "@/lib/saas-billing/types";
import { writeSettingsAuditLog } from "@/lib/settings-ops";

export const OFFBOARDING_CONFIRMATION = "CANCEL";

export const OFFBOARDING_PRESERVE_MESSAGE =
  "Cancellation does not delete customers, jobs, invoices, payments, expenses, time cards, or other historical records. Download a business export first.";

export const OFFBOARDING_BILLING_NOT_SCHEDULED_MESSAGE =
  "Billing cancellation is not yet scheduled.";

export const OFFBOARDING_BILLING_SCHEDULED_MESSAGE =
  "The billing provider scheduled cancel-at-period-end. Local subscription state stays unchanged until Stripe confirms it.";

export class OffboardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OffboardingError";
  }
}

function actorUserId(access: BusinessAccess) {
  return access.workspace.user?.id ?? access.workspace.membership.userId;
}

export async function requestBusinessOffboardingOp(
  prisma: PrismaClient,
  access: BusinessAccess,
  input: {
    confirmation: string;
    acknowledgedExport: boolean;
    currentPassword: string;
    totpOrBackupCode?: string;
  },
  options?: { provider?: SaasBillingProvider },
) {
  requireBusinessCapability(access, CAPABILITIES.REQUEST_OFFBOARDING);
  requireBusinessRole(access, "OWNER");

  const userId = actorUserId(access);
  if (!userId) {
    throw new OffboardingError("You need to sign in again.");
  }
  try {
    await requireSensitiveActionProof(prisma, userId, {
      password: input.currentPassword,
      totpOrBackupCode: input.totpOrBackupCode,
    });
  } catch (error) {
    if (error instanceof AccountSecurityError) {
      throw new OffboardingError(error.message);
    }
    throw error;
  }

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
  const stripeSubscriptionId = business.saasSubscription?.stripeSubscriptionId ?? null;
  const alreadyConfirmedByWebhook = business.saasSubscription?.cancelAtPeriodEnd === true;

  await prisma.$transaction(async (tx) => {
    await tx.business.update({
      where: { id: access.businessId },
      data: { offboardingRequestedAt: requestedAt },
    });
    await writeSettingsAuditLog(tx, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "data-export",
      settingKey: "offboardingRequestedAt",
      previousValue: business.offboardingRequestedAt,
      newValue: requestedAt,
    });
  });

  let billingCancellationScheduled = alreadyConfirmedByWebhook;
  if (!billingCancellationScheduled && stripeSubscriptionId) {
    try {
      const provider = options?.provider ?? getSaasBillingProvider();
      const scheduled = await provider.scheduleCancelAtPeriodEnd({
        subscriptionId: stripeSubscriptionId,
      });
      billingCancellationScheduled = scheduled.cancelAtPeriodEnd === true;
    } catch {
      billingCancellationScheduled = false;
    }
  }

  return {
    requestedAt,
    recordsDeleted: false,
    billingCancellationScheduled,
    billingCancellationMessage: billingCancellationScheduled
      ? OFFBOARDING_BILLING_SCHEDULED_MESSAGE
      : OFFBOARDING_BILLING_NOT_SCHEDULED_MESSAGE,
  };
}

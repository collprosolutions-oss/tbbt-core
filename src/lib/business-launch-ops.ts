/**
 * Business Launch mutations. Tenant scope always comes from BusinessAccess.
 * Writes go through existing Core services — this module never duplicates
 * Business / catalog / hours / brand / goal authority.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  requireBusinessCapability,
  requireBusinessRole,
} from "@/lib/authorization";
import {
  BUSINESS_LAUNCH_PATH,
  LAUNCH_NO_PUBLISH_MESSAGE,
  LAUNCH_NO_SILENT_PRICING_MESSAGE,
  LAUNCH_STEP_KEYS,
  LAUNCH_TRADE_CONFIRM_ONLY_MESSAGE,
  buildLaunchProgressSummary,
  isBusinessStage,
  isLaunchStepKey,
  isPricingApproach,
  type LaunchStepKey,
  type LaunchStepStatus,
} from "@/lib/business-launch";
import { createBusinessGoal } from "@/lib/bsos-ops";
import { listActiveTradeCodes } from "@/lib/business-trades";
import { createOwnedQuoteService } from "@/lib/catalog-ops";
import { saveMarketingBrandVoice } from "@/lib/marketing-ops";
import { upsertServiceArea } from "@/lib/service-area-ops";
import {
  SettingsError,
  updateBusinessProfileOp,
  updateBusinessPublicContactOp,
  updateLaborMinimumSettingsOp,
  updateLaunchProfileOp,
  updateSchedulingSettingsOp,
  updateSettingsPreferencesOp,
  updateWebsiteStoryOp,
} from "@/lib/settings-ops";
import { isConfiguredTrade } from "@/lib/trades";

type Db = PrismaClient;

export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchError";
  }
}

export function launchErrorMessage(error: unknown, fallback: string) {
  if (error instanceof LaunchError || error instanceof SettingsError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (error instanceof Error && error.name === "SaasSubscriptionRequiredError") return error.message;
  if (error instanceof Error && error.name === "CatalogOpsError") return error.message;
  if (error instanceof Error && error.name === "ServiceAreaError") return error.message;
  if (error instanceof Error && error.name === "BsosError") return error.message;
  return fallback;
}

export async function ensureLaunchProgress(db: Db, access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");
  const existing = await db.businessLaunchProgress.findFirst({
    where: { businessId: access.businessId },
    include: { steps: true },
  });
  if (existing) {
    const missing = LAUNCH_STEP_KEYS.filter(
      (key) => !existing.steps.some((step) => step.stepKey === key),
    );
    if (missing.length > 0) {
      await db.businessLaunchStep.createMany({
        data: missing.map((stepKey) => ({
          businessId: access.businessId,
          progressId: existing.id,
          stepKey,
          status: "PENDING",
        })),
      });
    }
    return db.businessLaunchProgress.findFirstOrThrow({
      where: { id: existing.id },
      include: { steps: true },
    });
  }
  return db.businessLaunchProgress.create({
    data: {
      businessId: access.businessId,
      createdByMembershipId: access.workspace.membership.id,
      steps: {
        create: LAUNCH_STEP_KEYS.map((stepKey) => ({
          businessId: access.businessId,
          stepKey,
          status: "PENDING",
        })),
      },
    },
    include: { steps: true },
  });
}

async function setStepStatus(
  db: Db,
  access: BusinessAccess,
  stepKey: LaunchStepKey,
  status: LaunchStepStatus,
) {
  const progress = await ensureLaunchProgress(db, access);
  const now = new Date();
  await db.businessLaunchStep.update({
    where: { businessId_stepKey: { businessId: access.businessId, stepKey } },
    data: {
      status,
      completedAt: status === "COMPLETED" ? now : null,
      skippedAt: status === "SKIPPED" ? now : null,
      deferredAt: status === "DEFERRED" ? now : null,
    },
  });
  const next = await db.businessLaunchProgress.findFirstOrThrow({
    where: { id: progress.id },
    include: { steps: true },
  });
  const summary = buildLaunchProgressSummary(next);
  await db.businessLaunchProgress.update({
    where: { id: progress.id },
    data: {
      lastStepKey: stepKey,
      status: summary.status,
      resumeLaterAt: null,
      completedAt: summary.status === "COMPLETED" ? next.completedAt ?? now : null,
    },
  });
  return summary;
}

export async function skipLaunchStep(db: Db, access: BusinessAccess, stepKey: string) {
  if (!isLaunchStepKey(stepKey)) throw new LaunchError("Choose a launch step.");
  return setStepStatus(db, access, stepKey, "SKIPPED");
}

export async function deferLaunchStep(db: Db, access: BusinessAccess, stepKey: string) {
  if (!isLaunchStepKey(stepKey)) throw new LaunchError("Choose a launch step.");
  return setStepStatus(db, access, stepKey, "DEFERRED");
}

export async function resumeLaunchLater(db: Db, access: BusinessAccess) {
  const progress = await ensureLaunchProgress(db, access);
  await db.businessLaunchProgress.update({
    where: { id: progress.id },
    data: { resumeLaterAt: new Date() },
  });
  return BUSINESS_LAUNCH_PATH;
}

export type LaunchStepInput = {
  stepKey: string;
  name?: string;
  phone?: string;
  email?: string;
  website?: string;
  serviceAreaLabel?: string;
  serviceAreaCity?: string;
  serviceAreaRegion?: string;
  serviceNames?: string[];
  pricingApproach?: string;
  laborMinimumEnabled?: boolean;
  laborMinimumAmount?: string;
  confirmPricing?: boolean;
  workStartMinutes?: number;
  workEndMinutes?: number;
  workingWeekdays?: number[];
  schedulingBufferMinutes?: number;
  schedulingNotes?: string;
  teamNotes?: string;
  paymentNotes?: string;
  estimateCommunicationEnabled?: boolean;
  scheduleNotificationEnabled?: boolean;
  invoiceCommunicationEnabled?: boolean;
  brandVoice?: string;
  identityNotes?: string;
  about?: string;
  goalTitle?: string;
  goalDescription?: string;
  businessStage?: string;
  confirmTrades?: string[];
};

export async function completeLaunchStep(
  db: Db,
  access: BusinessAccess,
  input: LaunchStepInput,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");
  if (!isLaunchStepKey(input.stepKey)) {
    throw new LaunchError("Choose a launch step.");
  }

  switch (input.stepKey) {
    case "identity": {
      await updateBusinessProfileOp(db, access, {
        name: input.name ?? "",
        confirmed: true,
      });
      await updateBusinessPublicContactOp(db, access, {
        phone: input.phone ?? "",
        email: input.email ?? "",
        website: input.website ?? "",
      });
      break;
    }
    case "trades": {
      const active = await listActiveTradeCodes(db, access.businessId);
      const requested = (input.confirmTrades ?? []).map((code) => code.trim()).filter(Boolean);
      for (const code of requested) {
        if (!isConfiguredTrade(code) || !active.includes(code)) {
          throw new LaunchError(LAUNCH_TRADE_CONFIRM_ONLY_MESSAGE);
        }
      }
      break;
    }
    case "service_area": {
      const label = input.serviceAreaLabel?.trim() ?? "";
      if (!label) throw new LaunchError("Enter the area you actually serve.");
      await updateBusinessPublicContactOp(db, access, {
        phone: input.phone ?? "",
        email: input.email ?? "",
        website: input.website ?? "",
        serviceArea: label,
      });
      if (input.serviceAreaCity?.trim()) {
        await upsertServiceArea(db, access, {
          kind: "CITY",
          label,
          city: input.serviceAreaCity,
          region: input.serviceAreaRegion,
        });
      }
      break;
    }
    case "services": {
      const names = (input.serviceNames ?? []).map((name) => name.trim()).filter(Boolean);
      for (const name of names) {
        await createOwnedQuoteService(db, access, { name });
      }
      break;
    }
    case "pricing": {
      if (input.pricingApproach && !isPricingApproach(input.pricingApproach)) {
        throw new LaunchError("Choose a pricing approach.");
      }
      if (input.pricingApproach) {
        await updateLaunchProfileOp(db, access, { pricingApproach: input.pricingApproach });
      }
      if (input.laborMinimumEnabled || input.laborMinimumAmount) {
        if (!input.confirmPricing) {
          throw new LaunchError(LAUNCH_NO_SILENT_PRICING_MESSAGE);
        }
        let amount: Prisma.Decimal | null = null;
        if (input.laborMinimumAmount) {
          try {
            amount = new Prisma.Decimal(input.laborMinimumAmount);
          } catch {
            throw new LaunchError("Enter a valid minimum service charge.");
          }
        }
        await updateLaborMinimumSettingsOp(db, access, {
          enabled: Boolean(input.laborMinimumEnabled),
          amount,
          confirmed: true,
        });
      }
      break;
    }
    case "hours": {
      await updateSchedulingSettingsOp(db, access, {
        workStartMinutes: input.workStartMinutes ?? 480,
        workEndMinutes: input.workEndMinutes ?? 1020,
        workingWeekdays: input.workingWeekdays?.length ? input.workingWeekdays : [1, 2, 3, 4, 5],
        schedulingBufferMinutes: input.schedulingBufferMinutes ?? 30,
        unavailableDates: [],
      });
      break;
    }
    case "scheduling": {
      if (input.schedulingBufferMinutes != null) {
        await updateSchedulingSettingsOp(db, access, {
          workStartMinutes: input.workStartMinutes ?? 480,
          workEndMinutes: input.workEndMinutes ?? 1020,
          workingWeekdays: input.workingWeekdays?.length ? input.workingWeekdays : [1, 2, 3, 4, 5],
          schedulingBufferMinutes: input.schedulingBufferMinutes,
          unavailableDates: [],
        });
      }
      await updateLaunchProfileOp(db, access, {
        schedulingPreferenceNotes: input.schedulingNotes ?? null,
      });
      break;
    }
    case "team": {
      await updateLaunchProfileOp(db, access, { teamStructureNotes: input.teamNotes ?? null });
      break;
    }
    case "payments": {
      await updateLaunchProfileOp(db, access, { paymentPreferenceNotes: input.paymentNotes ?? null });
      break;
    }
    case "communication": {
      await updateSettingsPreferencesOp(db, access, {
        estimateCommunicationEnabled: input.estimateCommunicationEnabled,
        scheduleNotificationEnabled: input.scheduleNotificationEnabled,
        invoiceCommunicationEnabled: input.invoiceCommunicationEnabled,
      });
      break;
    }
    case "brand_voice": {
      await saveMarketingBrandVoice(db, access, {
        brandVoice: input.brandVoice,
        identityNotes: input.identityNotes,
      });
      break;
    }
    case "website": {
      if (input.about?.trim()) {
        await updateWebsiteStoryOp(db, access, {
          rawOwnerStory: input.about,
          approvedPublicAboutCopy: input.about,
        });
      }
      void LAUNCH_NO_PUBLISH_MESSAGE;
      break;
    }
    case "goals": {
      const title = input.goalTitle?.trim() ?? "";
      if (!title) throw new LaunchError("Enter a business goal.");
      await createBusinessGoal(db, access, {
        title,
        description: input.goalDescription,
        recommendationKey: "launch-goal",
      });
      break;
    }
    case "stage": {
      if (!isBusinessStage(input.businessStage)) {
        throw new LaunchError("Choose the current business stage.");
      }
      await updateLaunchProfileOp(db, access, { businessStage: input.businessStage });
      break;
    }
    default:
      throw new LaunchError("Choose a launch step.");
  }

  return setStepStatus(db, access, input.stepKey, "COMPLETED");
}

/**
 * Settings mutations. Every write is tenant-scoped from requireBusinessAccess()
 * (never a browser-submitted businessId) and gated by MANAGE_SETTINGS.
 *
 * Consequential pricing / identity changes are OWNER-only. ADMIN may
 * persist only the explicitly delegated preference flags.
 *
 * Historical records are never rewritten here except DRAFT estimate totals
 * after a labor-minimum change (the existing persistDraftEstimateTotal
 * path, which no-ops for SENT / APPROVED estimates).
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  requireBusinessRole,
} from "@/lib/authorization";
import { persistDraftEstimateTotal } from "@/lib/labor-minimum";
import {
  DEFAULT_SETTINGS_PREFERENCES,
  serializeAuditValue,
  type SettingsPreferenceFlags,
} from "@/lib/settings";

type SettingsClient = PrismaClient | Prisma.TransactionClient;

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export function settingsErrorMessage(error: unknown, fallback: string) {
  if (error instanceof SettingsError || error instanceof ForbiddenError) {
    return error.message;
  }
  return fallback;
}

export async function ensureBusinessSettings(
  db: SettingsClient,
  businessId: string,
) {
  const existing = await db.businessSettings.findUnique({
    where: { businessId },
  });
  if (existing) {
    return existing;
  }
  return db.businessSettings.create({
    data: { businessId, ...DEFAULT_SETTINGS_PREFERENCES },
  });
}

export async function writeSettingsAuditLog(
  db: SettingsClient,
  input: {
    businessId: string;
    changedByMembershipId: string;
    settingArea: string;
    settingKey: string;
    previousValue: unknown;
    newValue: unknown;
  },
) {
  return db.settingsAuditLog.create({
    data: {
      businessId: input.businessId,
      changedByMembershipId: input.changedByMembershipId,
      settingArea: input.settingArea,
      settingKey: input.settingKey,
      previousValue: serializeAuditValue(input.settingKey, input.previousValue),
      newValue: serializeAuditValue(input.settingKey, input.newValue),
    },
  });
}

function requireConfirm(confirmed: boolean, message: string) {
  if (!confirmed) {
    throw new SettingsError(message);
  }
}

export async function updateLaborMinimumSettingsOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    enabled: boolean;
    amount: Prisma.Decimal | null;
    confirmed: boolean;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");

  if (input.enabled && (!input.amount || input.amount.lte(0))) {
    throw new SettingsError("Enter a minimum amount to turn this on.");
  }

  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { id: true, name: true, laborMinimumEnabled: true, laborMinimumAmount: true },
  });
  if (!business) {
    throw new SettingsError("Business was not found.");
  }

  const previous = {
    enabled: business.laborMinimumEnabled,
    amount: business.laborMinimumAmount?.toString() ?? null,
  };
  const next = {
    enabled: input.enabled,
    amount: input.amount?.toString() ?? null,
  };

  if (previous.enabled === next.enabled && previous.amount === next.amount) {
    return { unchanged: true as const };
  }

  requireConfirm(input.confirmed, "Confirm this pricing-rule change before saving.");

  await db.$transaction(async (tx) => {
    await tx.business.update({
      where: { id: access.businessId },
      data: {
        laborMinimumEnabled: input.enabled,
        laborMinimumAmount: input.amount,
      },
    });

    await writeSettingsAuditLog(tx, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "pricing",
      settingKey: "laborMinimum",
      previousValue: previous,
      newValue: next,
    });

    const drafts = await tx.estimate.findMany({
      where: { businessId: access.businessId, status: "DRAFT" },
      select: { id: true },
    });
    for (const draft of drafts) {
      await persistDraftEstimateTotal(tx, draft.id, access.businessId);
    }
  });

  return { unchanged: false as const };
}

export async function updateBusinessProfileOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: { name: string; confirmed: boolean },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");

  const name = input.name.trim();
  if (!name) {
    throw new SettingsError("Enter a business name.");
  }
  if (name.length > 120) {
    throw new SettingsError("Business name is too long.");
  }

  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { id: true, name: true },
  });
  if (!business) {
    throw new SettingsError("Business was not found.");
  }
  if (business.name === name) {
    return { unchanged: true as const };
  }

  requireConfirm(input.confirmed, "Confirm this business-name change before saving.");

  await db.$transaction(async (tx) => {
    await tx.business.update({
      where: { id: access.businessId },
      data: { name },
    });
    await writeSettingsAuditLog(tx, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "profile",
      settingKey: "name",
      previousValue: business.name,
      newValue: name,
    });
  });

  return { unchanged: false as const };
}

export async function updateSettingsPreferencesOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: Partial<SettingsPreferenceFlags>,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);

  const current = await ensureBusinessSettings(db, access.businessId);
  const next: SettingsPreferenceFlags = {
    estimateCommunicationEnabled: current.estimateCommunicationEnabled,
    scheduleNotificationEnabled: current.scheduleNotificationEnabled,
    invoiceCommunicationEnabled: current.invoiceCommunicationEnabled,
    reviewRequestPreferenceEnabled: current.reviewRequestPreferenceEnabled,
    marketingCommunicationEnabled: current.marketingCommunicationEnabled,
    notifyEstimateEvents: current.notifyEstimateEvents,
    notifyScheduleEvents: current.notifyScheduleEvents,
    notifyInvoiceEvents: current.notifyInvoiceEvents,
    notifyPayrollEvents: current.notifyPayrollEvents,
    notifyTeamEvents: current.notifyTeamEvents,
  };
  let changed = false;
  const keys = Object.keys(DEFAULT_SETTINGS_PREFERENCES) as Array<keyof SettingsPreferenceFlags>;
  for (const key of keys) {
    if (typeof input[key] === "boolean" && input[key] !== current[key]) {
      next[key] = input[key]!;
      changed = true;
    }
  }
  if (!changed) {
    return { unchanged: true as const };
  }

  await db.$transaction(async (tx) => {
    await tx.businessSettings.update({
      where: { businessId: access.businessId },
      data: next,
    });
    await writeSettingsAuditLog(tx, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "preferences",
      settingKey: "communicationAndNotifications",
      previousValue: {
        estimateCommunicationEnabled: current.estimateCommunicationEnabled,
        scheduleNotificationEnabled: current.scheduleNotificationEnabled,
        invoiceCommunicationEnabled: current.invoiceCommunicationEnabled,
        reviewRequestPreferenceEnabled: current.reviewRequestPreferenceEnabled,
        marketingCommunicationEnabled: current.marketingCommunicationEnabled,
        notifyEstimateEvents: current.notifyEstimateEvents,
        notifyScheduleEvents: current.notifyScheduleEvents,
        notifyInvoiceEvents: current.notifyInvoiceEvents,
        notifyPayrollEvents: current.notifyPayrollEvents,
        notifyTeamEvents: current.notifyTeamEvents,
      },
      newValue: next,
    });
  });

  return { unchanged: false as const };
}

/**
 * Reject a mutation that supplies a foreign businessId. Callers must never
 * use a browser-submitted businessId as the write target; this helper is
 * the focused isolation test for that contract.
 */
export function assertSettingsBusinessScope(
  access: BusinessAccess,
  submittedBusinessId: string | null | undefined,
) {
  if (submittedBusinessId && submittedBusinessId !== access.businessId) {
    throw new ForbiddenError();
  }
}

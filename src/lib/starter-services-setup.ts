/**
 * First-run starter services setup for the business's current trade.
 *
 * After identity setup, a new OWNER can install that trade's starter
 * catalog or skip. Completion is an explicit timestamp + choice, never
 * inferred from catalog item count. Today only Handyman has a starter
 * catalog; another trade can register later without a fake picker.
 *
 * Preview shares Production and skips migrate. Columns are added with a
 * one-shot backfill of businesses that already existed when the columns
 * appeared. Later ensure calls must not UPDATE WHERE NULL.
 */
import type { MembershipRole, Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import { isCollProRenoSlug } from "@/lib/public-site";
import { SettingsError, writeSettingsAuditLog } from "@/lib/settings-ops";
import { installHandymanStarterCatalogForBusiness } from "@/lib/starter-catalog-install";
import { isActiveTrade } from "@/lib/trades";

type SetupClient = PrismaClient | Prisma.TransactionClient;

export const STARTER_SERVICES_SETUP_PATH = "/setup/services";
export const STARTER_SERVICES_SETUP_INSTALLED = "INSTALLED";
export const STARTER_SERVICES_SETUP_SKIPPED = "SKIPPED";

export const STARTER_SERVICES_SETUP_ENSURE_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Business'
      AND column_name = 'starterServicesSetupCompletedAt'
  ) THEN
    ALTER TABLE "Business" ADD COLUMN "starterServicesSetupCompletedAt" TIMESTAMP(3);
    ALTER TABLE "Business" ADD COLUMN "starterServicesSetupChoice" TEXT;
    UPDATE "Business"
    SET "starterServicesSetupCompletedAt" = "createdAt"
    WHERE "starterServicesSetupCompletedAt" IS NULL;
  END IF;
END $$;
`.trim();

let ensureSchemaPromise: Promise<void> | null = null;

export function resetStarterServicesSetupSchemaEnsure() {
  ensureSchemaPromise = null;
}

export async function ensureStarterServicesSetupSchema(db: SetupClient) {
  if (!ensureSchemaPromise) {
    ensureSchemaPromise = (async () => {
      await db.$executeRawUnsafe(STARTER_SERVICES_SETUP_ENSURE_SQL);
    })().catch((error) => {
      ensureSchemaPromise = null;
      throw error;
    });
  }
  await ensureSchemaPromise;
}

export type StarterServicesSetupBusiness = {
  slug: string;
  tradeCode?: string | null;
  starterServicesSetupCompletedAt?: Date | null;
  starterServicesSetupChoice?: string | null;
};

/**
 * Handyman is the only trade with a starter catalog today.
 * Do not turn this into a fake multi-trade selector.
 */
export function tradeOffersOnboardingStarterCatalog(tradeCode: string | null | undefined) {
  return isActiveTrade(tradeCode ?? "");
}

export function hasCompletedStarterServicesSetup(business: StarterServicesSetupBusiness) {
  if (business.starterServicesSetupCompletedAt) return true;
  return isCollProRenoSlug(business.slug);
}

export function ownerNeedsStarterServicesSetup(input: {
  role: MembershipRole;
  business: StarterServicesSetupBusiness;
}) {
  if (input.role !== "OWNER") return false;
  if (hasCompletedStarterServicesSetup(input.business)) return false;
  return tradeOffersOnboardingStarterCatalog(input.business.tradeCode);
}

async function markStarterServicesSetupComplete(
  db: PrismaClient,
  access: BusinessAccess,
  choice: typeof STARTER_SERVICES_SETUP_INSTALLED | typeof STARTER_SERVICES_SETUP_SKIPPED,
) {
  const completedAt = new Date();
  await db.$transaction(async (tx) => {
    await tx.business.update({
      where: { id: access.businessId },
      data: {
        starterServicesSetupCompletedAt: completedAt,
        starterServicesSetupChoice: choice,
      },
    });
    await writeSettingsAuditLog(tx, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "onboarding",
      settingKey: "starterServicesSetupChoice",
      previousValue: null,
      newValue: choice,
    });
  });
  return completedAt;
}

async function loadStarterServicesBusiness(db: PrismaClient, businessId: string) {
  const current = await db.business.findFirst({
    where: { id: businessId },
    select: {
      id: true,
      slug: true,
      tradeCode: true,
      starterServicesSetupCompletedAt: true,
      starterServicesSetupChoice: true,
    },
  });
  if (!current) {
    throw new SettingsError("Business was not found.");
  }
  return current;
}

export async function installOnboardingStarterServicesOp(
  db: PrismaClient,
  access: BusinessAccess,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CATALOG);
  requireBusinessRole(access, "OWNER");
  await ensureStarterServicesSetupSchema(db);

  const current = await loadStarterServicesBusiness(db, access.businessId);
  if (isCollProRenoSlug(current.slug)) {
    throw new SettingsError("This business already has its service catalog.");
  }
  if (!tradeOffersOnboardingStarterCatalog(current.tradeCode)) {
    throw new SettingsError("Starter services are not available for this trade yet.");
  }
  if (hasCompletedStarterServicesSetup(current) && current.starterServicesSetupChoice === STARTER_SERVICES_SETUP_SKIPPED) {
    return {
      alreadyComplete: true as const,
      added: 0,
      skipped: 0,
      choice: STARTER_SERVICES_SETUP_SKIPPED,
    };
  }

  const result = await installHandymanStarterCatalogForBusiness(db, access.businessId);

  if (!current.starterServicesSetupCompletedAt) {
    await markStarterServicesSetupComplete(db, access, STARTER_SERVICES_SETUP_INSTALLED);
  }

  return {
    alreadyComplete: false as const,
    added: result.added,
    skipped: result.skipped,
    choice: STARTER_SERVICES_SETUP_INSTALLED,
  };
}

export async function skipOnboardingStarterServicesOp(
  db: PrismaClient,
  access: BusinessAccess,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CATALOG);
  requireBusinessRole(access, "OWNER");
  await ensureStarterServicesSetupSchema(db);

  const current = await loadStarterServicesBusiness(db, access.businessId);
  if (hasCompletedStarterServicesSetup(current) && current.starterServicesSetupCompletedAt) {
    return {
      alreadyComplete: true as const,
      choice: current.starterServicesSetupChoice,
    };
  }
  if (isCollProRenoSlug(current.slug)) {
    return { alreadyComplete: true as const, choice: current.starterServicesSetupChoice };
  }

  await markStarterServicesSetupComplete(db, access, STARTER_SERVICES_SETUP_SKIPPED);
  return {
    alreadyComplete: false as const,
    choice: STARTER_SERVICES_SETUP_SKIPPED,
  };
}

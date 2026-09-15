/**
 * First-run OWNER business identity setup.
 *
 * Signup already creates User + Business + OWNER Membership. This module
 * adds the smallest explicit completion timestamp so a brand-new OWNER is
 * sent through /setup instead of an unfinished Dashboard. Completion is
 * never inferred from phone/email being populated.
 *
 * Preview shares Production and skips migrate. The column is added with a
 * one-shot backfill of businesses that already existed when the column
 * appeared. Later ensure calls must not UPDATE WHERE NULL.
 */
import type { MembershipRole, Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import { isCollProRenoSlug } from "@/lib/public-site";
import {
  SettingsError,
  updateBusinessProfileOp,
  updateBusinessPublicContactOp,
  writeSettingsAuditLog,
} from "@/lib/settings-ops";
import {
  ownerNeedsStarterServicesSetup,
  STARTER_SERVICES_SETUP_PATH,
} from "@/lib/starter-services-setup";

type SetupClient = PrismaClient | Prisma.TransactionClient;

export const FIRST_RUN_SETUP_PATH = "/setup";

export const FIRST_RUN_SETUP_ENSURE_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Business'
      AND column_name = 'firstRunSetupCompletedAt'
  ) THEN
    ALTER TABLE "Business" ADD COLUMN "firstRunSetupCompletedAt" TIMESTAMP(3);
    UPDATE "Business"
    SET "firstRunSetupCompletedAt" = "createdAt"
    WHERE "firstRunSetupCompletedAt" IS NULL;
  END IF;
END $$;
`.trim();

let ensureSchemaPromise: Promise<void> | null = null;

export function resetFirstRunSetupSchemaEnsure() {
  ensureSchemaPromise = null;
}

export async function ensureFirstRunSetupSchema(db: SetupClient) {
  if (!ensureSchemaPromise) {
    ensureSchemaPromise = (async () => {
      await db.$executeRawUnsafe(FIRST_RUN_SETUP_ENSURE_SQL);
    })().catch((error) => {
      ensureSchemaPromise = null;
      throw error;
    });
  }
  await ensureSchemaPromise;
}

export type FirstRunSetupBusiness = {
  slug: string;
  tradeCode?: string | null;
  firstRunSetupCompletedAt?: Date | null;
  starterServicesSetupCompletedAt?: Date | null;
  starterServicesSetupChoice?: string | null;
};

export function hasCompletedFirstRunSetup(business: FirstRunSetupBusiness) {
  if (business.firstRunSetupCompletedAt) return true;
  // CollPro Reno is the live launch tenant. Never trap it in owner onboarding
  // if a preview deploy added the column before production migrate backfill.
  return isCollProRenoSlug(business.slug);
}

export function ownerNeedsFirstRunSetup(input: {
  role: MembershipRole;
  business: FirstRunSetupBusiness;
}) {
  return input.role === "OWNER" && !hasCompletedFirstRunSetup(input.business);
}

export function postAuthenticationPath(input: {
  role: MembershipRole;
  business: FirstRunSetupBusiness;
}) {
  if (input.role === "MEMBER") return "/field";
  if (ownerNeedsFirstRunSetup(input)) return FIRST_RUN_SETUP_PATH;
  if (ownerNeedsStarterServicesSetup(input)) return STARTER_SERVICES_SETUP_PATH;
  return "/dashboard";
}

export async function completeFirstRunSetupOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: { name: string; phone: string; email: string; website: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");
  await ensureFirstRunSetupSchema(db);

  const phone = input.phone.trim();
  const email = input.email.trim();
  if (!phone) {
    throw new SettingsError("Enter a public phone number.");
  }
  if (!email) {
    throw new SettingsError("Enter a public email address.");
  }

  const current = await db.business.findFirst({
    where: { id: access.businessId },
    select: {
      id: true,
      slug: true,
      firstRunSetupCompletedAt: true,
    },
  });
  if (!current) {
    throw new SettingsError("Business was not found.");
  }
  if (hasCompletedFirstRunSetup(current) && current.firstRunSetupCompletedAt) {
    return { alreadyComplete: true as const };
  }

  await updateBusinessProfileOp(db, access, {
    name: input.name,
    confirmed: true,
  });
  await updateBusinessPublicContactOp(db, access, {
    phone: input.phone,
    email: input.email,
    website: input.website,
  });

  const completedAt = new Date();
  await db.$transaction(async (tx) => {
    await tx.business.update({
      where: { id: access.businessId },
      data: { firstRunSetupCompletedAt: completedAt },
    });
    await writeSettingsAuditLog(tx, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "onboarding",
      settingKey: "firstRunSetupCompletedAt",
      previousValue: null,
      newValue: completedAt.toISOString(),
    });
  });

  return { alreadyComplete: false as const };
}

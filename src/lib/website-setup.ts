/**
 * First-run public website setup for the business's existing /hire/[slug] site.
 *
 * After identity and starter-services setup, a new OWNER can save a short
 * About story and primary service area, or skip. Completion is an explicit
 * timestamp + choice, never inferred from About/service-area text. The
 * public site stays the TBBT-hosted /hire/[slug] route — not CollPro's
 * apex /, and not a custom domain.
 *
 * Preview shares Production and skips migrate. Completion columns are
 * added with a one-shot backfill of businesses that already existed when
 * the columns appeared. Later ensure calls must not UPDATE WHERE NULL.
 * publicServiceAreaLabel is additive with no backfill.
 */
import type { MembershipRole, Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import { isCollProRenoSlug } from "@/lib/public-site";
import {
  SettingsError,
  updateBusinessProfileOp,
  updateBusinessPublicContactOp,
  updateWebsiteStoryOp,
  writeSettingsAuditLog,
} from "@/lib/settings-ops";
import { MAX_PUBLIC_ABOUT_COPY_LENGTH, normalizeAboutCopy } from "@/lib/website-story";

type SetupClient = PrismaClient | Prisma.TransactionClient;

export const WEBSITE_SETUP_PATH = "/setup/website";
export const WEBSITE_SETUP_SAVED = "SAVED";
export const WEBSITE_SETUP_SKIPPED = "SKIPPED";

export type WebsiteSetupCompletionCopy = {
  title: string;
  description: string;
  alert: string;
};

export function websiteSetupCompletionCopy(input: {
  choice: string | null | undefined;
  publicPath: string;
}): WebsiteSetupCompletionCopy {
  if (input.choice === WEBSITE_SETUP_SKIPPED) {
    return {
      title: "Website setup skipped",
      description: `The default TBBT ${input.publicPath} route exists. You skipped About and service-area setup. You can finish website details later in Settings.`,
      alert:
        "You skipped About and service-area setup. The default TBBT public route still exists, and you can finish website details later in Settings.",
    };
  }
  return {
    title: "Public website ready",
    description:
      "Homeowners can visit this business at its TBBT public site. You can change these details later in Settings.",
    alert: "Your public website is live. Open it, then continue to the Dashboard.",
  };
}

export const WEBSITE_SETUP_ENSURE_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Business'
      AND column_name = 'websiteSetupCompletedAt'
  ) THEN
    ALTER TABLE "Business" ADD COLUMN "websiteSetupCompletedAt" TIMESTAMP(3);
    ALTER TABLE "Business" ADD COLUMN "websiteSetupChoice" TEXT;
    UPDATE "Business"
    SET "websiteSetupCompletedAt" = "createdAt"
    WHERE "websiteSetupCompletedAt" IS NULL;
  END IF;
END $$;
`.trim();

export const PUBLIC_SERVICE_AREA_LABEL_ENSURE_SQL =
  `ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "publicServiceAreaLabel" TEXT`;

let ensureSchemaPromise: Promise<void> | null = null;

export function resetWebsiteSetupSchemaEnsure() {
  ensureSchemaPromise = null;
}

export async function ensureWebsiteSetupSchema(db: SetupClient) {
  if (!ensureSchemaPromise) {
    ensureSchemaPromise = (async () => {
      await db.$executeRawUnsafe(WEBSITE_SETUP_ENSURE_SQL);
      await db.$executeRawUnsafe(PUBLIC_SERVICE_AREA_LABEL_ENSURE_SQL);
    })().catch((error) => {
      ensureSchemaPromise = null;
      throw error;
    });
  }
  await ensureSchemaPromise;
}

export type WebsiteSetupBusiness = {
  slug: string;
  websiteSetupCompletedAt?: Date | null;
  websiteSetupChoice?: string | null;
};

export function hasCompletedWebsiteSetup(business: WebsiteSetupBusiness) {
  if (business.websiteSetupCompletedAt) return true;
  return isCollProRenoSlug(business.slug);
}

export function ownerNeedsWebsiteSetup(input: {
  role: MembershipRole;
  business: WebsiteSetupBusiness;
}) {
  return input.role === "OWNER" && !hasCompletedWebsiteSetup(input.business);
}

async function markWebsiteSetupComplete(
  db: PrismaClient,
  access: BusinessAccess,
  choice: typeof WEBSITE_SETUP_SAVED | typeof WEBSITE_SETUP_SKIPPED,
) {
  const completedAt = new Date();
  await db.$transaction(async (tx) => {
    await tx.business.update({
      where: { id: access.businessId },
      data: {
        websiteSetupCompletedAt: completedAt,
        websiteSetupChoice: choice,
      },
    });
    await writeSettingsAuditLog(tx, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "onboarding",
      settingKey: "websiteSetupChoice",
      previousValue: null,
      newValue: choice,
    });
  });
  return completedAt;
}

async function loadWebsiteSetupBusiness(db: PrismaClient, businessId: string) {
  const current = await db.business.findFirst({
    where: { id: businessId },
    select: {
      id: true,
      slug: true,
      publicWebsite: true,
      websiteSetupCompletedAt: true,
      websiteSetupChoice: true,
      settings: { select: { rawOwnerStory: true } },
    },
  });
  if (!current) {
    throw new SettingsError("Business was not found.");
  }
  return current;
}

export async function completeWebsiteSetupOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    name: string;
    phone: string;
    email: string;
    about: string;
    serviceArea: string;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");
  await ensureWebsiteSetupSchema(db);

  const phone = input.phone.trim();
  const email = input.email.trim();
  const about = normalizeAboutCopy(input.about, MAX_PUBLIC_ABOUT_COPY_LENGTH);
  const serviceArea = input.serviceArea.trim();
  if (!input.name.trim()) {
    throw new SettingsError("Enter a public business name.");
  }
  if (!phone) {
    throw new SettingsError("Enter a public phone number.");
  }
  if (!email) {
    throw new SettingsError("Enter a public email address.");
  }
  if (about == null) {
    throw new SettingsError("The public About copy is too long.");
  }
  if (!about) {
    throw new SettingsError("Enter a short About description.");
  }
  if (!serviceArea) {
    throw new SettingsError("Enter the primary area you serve.");
  }

  const current = await loadWebsiteSetupBusiness(db, access.businessId);
  if (hasCompletedWebsiteSetup(current) && current.websiteSetupCompletedAt) {
    return { alreadyComplete: true as const, choice: current.websiteSetupChoice };
  }
  if (isCollProRenoSlug(current.slug)) {
    return { alreadyComplete: true as const, choice: current.websiteSetupChoice };
  }

  await updateBusinessProfileOp(db, access, {
    name: input.name,
    confirmed: true,
  });
  await updateBusinessPublicContactOp(db, access, {
    phone: input.phone,
    email: input.email,
    website: current.publicWebsite ?? "",
    serviceArea: input.serviceArea,
  });
  await updateWebsiteStoryOp(db, access, {
    rawOwnerStory: current.settings?.rawOwnerStory ?? "",
    approvedPublicAboutCopy: input.about,
  });
  await markWebsiteSetupComplete(db, access, WEBSITE_SETUP_SAVED);
  return { alreadyComplete: false as const, choice: WEBSITE_SETUP_SAVED };
}

export async function skipWebsiteSetupOp(
  db: PrismaClient,
  access: BusinessAccess,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");
  await ensureWebsiteSetupSchema(db);

  const current = await loadWebsiteSetupBusiness(db, access.businessId);
  if (hasCompletedWebsiteSetup(current) && current.websiteSetupCompletedAt) {
    return {
      alreadyComplete: true as const,
      choice: current.websiteSetupChoice,
    };
  }
  if (isCollProRenoSlug(current.slug)) {
    return { alreadyComplete: true as const, choice: current.websiteSetupChoice };
  }

  await markWebsiteSetupComplete(db, access, WEBSITE_SETUP_SKIPPED);
  return {
    alreadyComplete: false as const,
    choice: WEBSITE_SETUP_SKIPPED,
  };
}

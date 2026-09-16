"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireBusinessAccess } from "@/lib/access";
import { postAuthenticationPath } from "@/lib/first-run-setup";
import { prisma } from "@/lib/prisma";
import { startFounderTrialIfEligible } from "@/lib/saas-billing";
import { settingsErrorMessage } from "@/lib/settings-ops";
import {
  completeWebsiteSetupOp,
  skipWebsiteSetupOp,
  WEBSITE_SETUP_PATH,
} from "@/lib/website-setup";

export type WebsiteSetupState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function completeWebsiteSetupAction(
  _prev: WebsiteSetupState,
  formData: FormData,
): Promise<WebsiteSetupState> {
  try {
    const access = await requireBusinessAccess();
    const result = await completeWebsiteSetupOp(prisma, access, {
      name: readString(formData, "businessName"),
      phone: readString(formData, "publicPhone"),
      email: readString(formData, "publicEmail"),
      about: readString(formData, "approvedPublicAboutCopy"),
      serviceArea: readString(formData, "publicServiceAreaLabel"),
    });
    if (!result.alreadyComplete) {
      await startFounderTrialIfEligible(prisma, {
        businessId: access.businessId,
        slug: access.workspace.business.slug,
        changedByMembershipId: access.workspace.membership.id,
      });
    }
    revalidatePath("/settings");
    revalidatePath(`/hire/${access.workspace.business.slug}`);
    revalidatePath(`/hire/${access.workspace.business.slug}/about`);
    revalidatePath(`/hire/${access.workspace.business.slug}/service-area`);
    revalidatePath(`/hire/${access.workspace.business.slug}/contact`);
  } catch (error) {
    return {
      error: settingsErrorMessage(error, "That website information could not be saved."),
    };
  }

  redirect(WEBSITE_SETUP_PATH);
}

export async function skipWebsiteSetupAction(): Promise<void> {
  const access = await requireBusinessAccess();
  const result = await skipWebsiteSetupOp(prisma, access);
  if (!result.alreadyComplete) {
    await startFounderTrialIfEligible(prisma, {
      businessId: access.businessId,
      slug: access.workspace.business.slug,
      changedByMembershipId: access.workspace.membership.id,
    });
  }
  redirect(
    postAuthenticationPath({
      role: access.workspace.role,
      business: {
        ...access.workspace.business,
        websiteSetupCompletedAt: new Date(),
      },
    }),
  );
}

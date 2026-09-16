"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireBusinessAccess } from "@/lib/access";
import { postAuthenticationPath } from "@/lib/first-run-setup";
import { prisma } from "@/lib/prisma";
import { settingsErrorMessage } from "@/lib/settings-ops";
import {
  installOnboardingStarterServicesOp,
  skipOnboardingStarterServicesOp,
} from "@/lib/starter-services-setup";

export type StarterServicesSetupState = {
  error?: string;
  message?: string;
  added?: number;
  skipped?: number;
  installed?: boolean;
};

export async function installOnboardingStarterServicesAction(
  _prev: StarterServicesSetupState,
): Promise<StarterServicesSetupState> {
  try {
    const access = await requireBusinessAccess();
    const result = await installOnboardingStarterServicesOp(prisma, access);
    revalidatePath("/services");
    return {
      installed: true,
      added: result.added,
      skipped: result.skipped,
      message:
        result.added > 0
          ? `Added ${result.added} Handyman starter services. You can edit them anytime on the Services page.`
          : "Those Handyman starter services are already on your list. You can continue to the Dashboard.",
    };
  } catch (error) {
    return {
      error: settingsErrorMessage(error, "Those starter services could not be added."),
    };
  }
}

export async function skipOnboardingStarterServicesAction(): Promise<void> {
  const access = await requireBusinessAccess();
  await skipOnboardingStarterServicesOp(prisma, access);
  redirect(
    postAuthenticationPath({
      role: access.workspace.role,
      business: {
        ...access.workspace.business,
        starterServicesSetupCompletedAt: new Date(),
      },
    }),
  );
}

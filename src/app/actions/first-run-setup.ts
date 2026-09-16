"use server";

import { redirect } from "next/navigation";
import { requireBusinessAccess } from "@/lib/access";
import { completeFirstRunSetupOp, postAuthenticationPath } from "@/lib/first-run-setup";
import { prisma } from "@/lib/prisma";
import { settingsErrorMessage } from "@/lib/settings-ops";

export type FirstRunSetupState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function completeFirstRunSetupAction(
  _prev: FirstRunSetupState,
  formData: FormData,
): Promise<FirstRunSetupState> {
  let nextPath = "/dashboard";
  try {
    const access = await requireBusinessAccess();
    await completeFirstRunSetupOp(prisma, access, {
      name: readString(formData, "businessName"),
      phone: readString(formData, "publicPhone"),
      email: readString(formData, "publicEmail"),
      website: readString(formData, "publicWebsite"),
    });
    nextPath = postAuthenticationPath({
      role: access.workspace.role,
      business: {
        ...access.workspace.business,
        firstRunSetupCompletedAt: new Date(),
      },
    });
  } catch (error) {
    return {
      error: settingsErrorMessage(error, "That business information could not be saved."),
    };
  }

  redirect(nextPath);
}

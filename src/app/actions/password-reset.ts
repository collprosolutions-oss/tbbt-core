"use server";

import { redirect } from "next/navigation";
import { createSession, setWorkspaceCookie } from "@/lib/auth";
import { ensureBusinessPublicContactSchema } from "@/lib/business-contact";
import {
  ensureFirstRunSetupSchema,
  postAuthenticationPath,
} from "@/lib/first-run-setup";
import {
  completePasswordResetOp,
  requestPasswordResetOp,
} from "@/lib/password-reset";
import { prisma } from "@/lib/prisma";
import { ensureSaasBillingSchema } from "@/lib/saas-billing";
import { ensureStarterServicesSetupSchema } from "@/lib/starter-services-setup";
import { ensureWebsiteSetupSchema } from "@/lib/website-setup";

export type PasswordResetRequestState = {
  error?: string;
  message?: string;
};

export type PasswordResetCompleteState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function requestPasswordResetAction(
  _prev: PasswordResetRequestState,
  formData: FormData,
): Promise<PasswordResetRequestState> {
  const result = await requestPasswordResetOp(
    prisma,
    readString(formData, "email"),
  );
  if (result.outcome === "invalid-email") {
    return { error: result.message };
  }
  return { message: result.message };
}

export async function completePasswordResetAction(
  _prev: PasswordResetCompleteState,
  formData: FormData,
): Promise<PasswordResetCompleteState> {
  const result = await completePasswordResetOp(prisma, {
    token: readString(formData, "token"),
    password: readString(formData, "password"),
    confirmPassword: readString(formData, "confirmPassword"),
  });

  if (!result.ok) {
    return { error: result.error };
  }

  await ensureBusinessPublicContactSchema(prisma);
  await ensureFirstRunSetupSchema(prisma);
  await ensureStarterServicesSetupSchema(prisma);
  await ensureWebsiteSetupSchema(prisma);
  await ensureSaasBillingSchema(prisma);

  const membership = await prisma.membership.findFirst({
    where: { userId: result.userId, active: true },
    orderBy: { createdAt: "asc" },
    include: { business: true },
  });

  await createSession(result.userId);
  if (membership) {
    await setWorkspaceCookie(membership.businessId);
    redirect(
      postAuthenticationPath({
        role: membership.role,
        business: membership.business,
      }),
    );
  }

  redirect("/sign-in");
}

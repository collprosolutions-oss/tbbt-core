"use server";

import { getSessionUser } from "@/lib/auth";
import { changeSignedInPasswordOp } from "@/lib/password-reset";
import { prisma } from "@/lib/prisma";

export type ChangePasswordState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const session = await getSessionUser();
  if (!session) {
    return { error: "You need to sign in again." };
  }

  const result = await changeSignedInPasswordOp(prisma, {
    userId: session.id,
    currentPassword: readString(formData, "currentPassword"),
    newPassword: readString(formData, "newPassword"),
    confirmPassword: readString(formData, "confirmPassword"),
  });

  if (!result.ok) {
    return { error: result.error };
  }

  return { message: "Your password has been updated." };
}

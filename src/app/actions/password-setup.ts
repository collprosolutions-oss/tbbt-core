"use server";

/**
 * Completes a brand-new team member's onboarding started by addTeamMember()
 * in src/app/actions/team.ts. The raw token (from the one-time setup URL)
 * proves possession of the link; the member then chooses their OWN
 * password here, which is hashed and stored exactly like any other
 * password (see src/lib/auth.ts) -- it is never visible to, or stored by,
 * the owner/admin who added them.
 */
import { redirect } from "next/navigation";
import {
  createSession,
  hashPassword,
  hashToken,
  setWorkspaceCookie,
} from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export type PasswordSetupActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function completePasswordSetup(
  _prev: PasswordSetupActionState,
  formData: FormData,
): Promise<PasswordSetupActionState> {
  const token = readString(formData, "token");
  const password = readString(formData, "password");
  const confirmPassword = readString(formData, "confirmPassword");

  if (!token) {
    return { error: "This setup link is invalid." };
  }
  if (!password || password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (password !== confirmPassword) {
    return { error: "Passwords do not match." };
  }

  const setupToken = await prisma.passwordSetupToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });

  // A generic message either way -- an invalid, already-used, or expired
  // token must not distinguish "does not exist" from "expired"/"used",
  // which would leak whether a given link was ever real.
  if (!setupToken || setupToken.usedAt || setupToken.expiresAt < new Date()) {
    return {
      error:
        "This setup link is invalid or has expired. Ask your business owner or admin for a new one.",
    };
  }

  const passwordHash = await hashPassword(password);
  const membership = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: setupToken.userId },
      data: { passwordHash },
    });
    // Single-use: mark the token spent in the SAME transaction as the
    // password write, so it can never be replayed even by a concurrent
    // request racing this one.
    await tx.passwordSetupToken.update({
      where: { id: setupToken.id },
      data: { usedAt: new Date() },
    });
    return tx.membership.findFirst({
      where: { userId: setupToken.userId, active: true },
      orderBy: { createdAt: "asc" },
    });
  });

  await createSession(setupToken.userId);
  if (membership) {
    await setWorkspaceCookie(membership.businessId);
  }

  // This flow only ever onboards a MEMBER (see addTeamMember()) -- route
  // exactly where an existing MEMBER's sign-in already lands (see
  // signInAction() in src/app/actions/auth.ts).
  redirect("/field");
}

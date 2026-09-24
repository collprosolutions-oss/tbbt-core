"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/auth";
import {
  AccountSecurityError,
  confirmTotpEnrollmentOp,
  disableTotpOp,
  revokeOtherSessionsOp,
  revokeSessionOp,
  startTotpEnrollmentOp,
} from "@/lib/account-security";
import { prisma } from "@/lib/prisma";
import { writeSettingsAuditLog } from "@/lib/settings-ops";
import { requireBusinessAccess } from "@/lib/access";

export type AccountSecurityState = {
  error?: string;
  message?: string;
  otpauthUrl?: string;
  secret?: string;
  backupCodes?: string[];
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function audit(settingKey: string, previousValue: unknown, newValue: unknown) {
  try {
    const access = await requireBusinessAccess();
    await writeSettingsAuditLog(prisma, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "security",
      settingKey,
      previousValue,
      newValue,
    });
  } catch {
    // User-scoped security still works without a workspace audit row.
  }
}

export async function startTotpEnrollmentAction(
  _prev: AccountSecurityState,
  _formData: FormData,
): Promise<AccountSecurityState> {
  const session = await getSessionUser();
  if (!session) return { error: "You need to sign in again." };
  try {
    const started = await startTotpEnrollmentOp(prisma, {
      userId: session.id,
      accountName: session.email,
    });
    await audit("totpEnrollment", "off", "pending");
    revalidatePath("/settings");
    return {
      message: "Scan the authenticator URI or enter the secret, then confirm with a code.",
      otpauthUrl: started.otpauthUrl,
      secret: started.secret,
    };
  } catch (error) {
    if (error instanceof AccountSecurityError) return { error: error.message };
    throw error;
  }
}

export async function confirmTotpEnrollmentAction(
  _prev: AccountSecurityState,
  formData: FormData,
): Promise<AccountSecurityState> {
  const session = await getSessionUser();
  if (!session) return { error: "You need to sign in again." };
  try {
    const confirmed = await confirmTotpEnrollmentOp(prisma, {
      userId: session.id,
      code: readString(formData, "code"),
    });
    await audit("totpEnabled", false, true);
    revalidatePath("/settings");
    return {
      message: "Authenticator app sign-in is enabled. Save these backup codes now — they are shown once.",
      backupCodes: confirmed.backupCodes,
    };
  } catch (error) {
    if (error instanceof AccountSecurityError) return { error: error.message };
    throw error;
  }
}

export async function disableTotpAction(
  _prev: AccountSecurityState,
  formData: FormData,
): Promise<AccountSecurityState> {
  const session = await getSessionUser();
  if (!session) return { error: "You need to sign in again." };
  try {
    await disableTotpOp(prisma, {
      userId: session.id,
      code: readString(formData, "code"),
    });
    await audit("totpEnabled", true, false);
    revalidatePath("/settings");
    return { message: "Authenticator app sign-in is turned off." };
  } catch (error) {
    if (error instanceof AccountSecurityError) return { error: error.message };
    throw error;
  }
}

export async function revokeSessionAction(
  _prev: AccountSecurityState,
  formData: FormData,
): Promise<AccountSecurityState> {
  const session = await getSessionUser();
  if (!session) return { error: "You need to sign in again." };
  try {
    await revokeSessionOp(prisma, {
      userId: session.id,
      sessionId: readString(formData, "sessionId"),
      currentSessionId: session.sessionId,
    });
    await audit("sessionRevoked", readString(formData, "sessionId"), "revoked");
    revalidatePath("/settings");
    return { message: "That session can no longer be used." };
  } catch (error) {
    if (error instanceof AccountSecurityError) return { error: error.message };
    throw error;
  }
}

export async function revokeOtherSessionsAction(
  _prev: AccountSecurityState,
  _formData: FormData,
): Promise<AccountSecurityState> {
  const session = await getSessionUser();
  if (!session) return { error: "You need to sign in again." };
  const count = await revokeOtherSessionsOp(prisma, {
    userId: session.id,
    currentSessionId: session.sessionId,
  });
  await audit("otherSessionsRevoked", null, count);
  revalidatePath("/settings");
  return {
    message:
      count === 0
        ? "No other sessions were active."
        : `Signed out ${count} other session${count === 1 ? "" : "s"}.`,
  };
}

export async function currentRequestUserAgent() {
  return (await headers()).get("user-agent");
}

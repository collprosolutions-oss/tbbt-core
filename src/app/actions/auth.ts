"use server";

import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import {
  createSession,
  destroySession,
  hashPassword,
  setWorkspaceCookie,
  verifyPassword,
} from "@/lib/auth";
import { ensureBusinessPublicContactSchema } from "@/lib/business-contact";
import {
  ensureFirstRunSetupSchema,
  postAuthenticationPath,
} from "@/lib/first-run-setup";
import { prisma } from "@/lib/prisma";
import { provisionNewOwnerWithFounderTrial } from "@/lib/public-signup-handoff";
import { ensureStarterServicesSetupSchema } from "@/lib/starter-services-setup";
import { ensureWebsiteSetupSchema } from "@/lib/website-setup";
import { ensureSaasBillingSchema } from "@/lib/saas-billing";

export type AuthFormState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function signUpAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const name = readString(formData, "name");
  const email = readString(formData, "email").toLowerCase();
  const password = readString(formData, "password");
  const businessName = readString(formData, "businessName");

  if (!name || !email || !password || !businessName) {
    return { error: "Name, email, password, and business name are required." };
  }

  if (!email.includes("@")) {
    return { error: "Enter a valid email address." };
  }

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { error: "An account with that email already exists." };
  }

  const passwordHash = await hashPassword(password);
  let result: Awaited<ReturnType<typeof provisionNewOwnerWithFounderTrial>>;
  try {
    result = await provisionNewOwnerWithFounderTrial(prisma, {
      name,
      email,
      passwordHash,
      businessName,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { error: "An account with that email already exists." };
    }
    throw error;
  }

  await createSession(result.user.id);
  await setWorkspaceCookie(result.business.id);
  redirect(result.nextPath);
}

export async function signInAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = readString(formData, "email").toLowerCase();
  const password = readString(formData, "password");

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  await ensureBusinessPublicContactSchema(prisma);
  await ensureFirstRunSetupSchema(prisma);
  await ensureStarterServicesSetupSchema(prisma);
  await ensureWebsiteSetupSchema(prisma);
  await ensureSaasBillingSchema(prisma);

  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      // Only an ACTIVE membership can sign in to that workspace -- matches
      // requireWorkspace() in src/lib/workspace.ts, so a deactivated
      // MEMBER (see removeTeamMember() in src/app/actions/team.ts) is
      // rejected here too, not just bounced later.
      memberships: {
        where: { active: true },
        orderBy: { createdAt: "asc" },
        include: { business: true },
      },
    },
  });

  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return { error: "Email or password is incorrect." };
  }

  const membership = user.memberships[0];
  if (!membership) {
    return { error: "This account is not assigned to a business workspace." };
  }

  await createSession(user.id);
  await setWorkspaceCookie(membership.businessId);
  // OWNER/ADMIN land on the management console; MEMBER lands directly on
  // their own Field Home ("My Jobs") -- they have no management-console
  // read access (see canAccessManagementConsole() in
  // src/lib/authorization.ts), so sending them to /dashboard first would
  // just bounce them through /access-restricted for no reason.
  // A brand-new OWNER who has not finished first-run setup is sent to
  // /setup instead of an unfinished Dashboard.
  redirect(
    postAuthenticationPath({
      role: membership.role,
      business: membership.business,
    }),
  );
}

export async function signOutAction() {
  await destroySession();
  redirect("/sign-in");
}

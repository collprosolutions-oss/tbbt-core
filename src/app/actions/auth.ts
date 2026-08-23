"use server";

import { redirect } from "next/navigation";
import {
  createSession,
  destroySession,
  hashPassword,
  setWorkspaceCookie,
  verifyPassword,
} from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_TRADE } from "@/lib/trades";

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

  const user = await prisma.$transaction(async (tx) => {
    const createdUser = await tx.user.create({
      data: { name, email, passwordHash },
    });

    const business = await tx.business.create({
      data: {
        name: businessName,
        tradeCode: DEFAULT_TRADE,
      },
    });

    await tx.membership.create({
      data: {
        userId: createdUser.id,
        businessId: business.id,
        role: "OWNER",
      },
    });

    return { user: createdUser, business };
  });

  await createSession(user.user.id);
  await setWorkspaceCookie(user.business.id);
  redirect("/dashboard");
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

  const user = await prisma.user.findUnique({
    where: { email },
    include: { memberships: { orderBy: { createdAt: "asc" } } },
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
  redirect("/dashboard");
}

export async function signOutAction() {
  await destroySession();
  redirect("/sign-in");
}

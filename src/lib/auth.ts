import { cookies } from "next/headers";
import {
  createSecureToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from "@/lib/auth-crypto";
import { SESSION_COOKIE, WORKSPACE_COOKIE } from "@/lib/cookies";
import { prisma } from "@/lib/prisma";

export { SESSION_COOKIE, WORKSPACE_COOKIE };
export { createSecureToken, hashPassword, hashToken, verifyPassword };

const SESSION_DAYS = 30;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  sessionId: string;
  totpEnabled: boolean;
};

export function createSessionToken() {
  return createSecureToken();
}

function cookieSecure() {
  return process.env.NODE_ENV === "production";
}

export async function createSession(userId: string, options?: { userAgent?: string | null }) {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const userAgent = options?.userAgent?.trim().slice(0, 240) || null;

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/",
    expires: expiresAt,
  });
}

export async function setWorkspaceCookie(businessId: string) {
  const cookieStore = await cookies();
  cookieStore.set(WORKSPACE_COOKIE, businessId, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function getWorkspaceCookie() {
  const cookieStore = await cookies();
  return cookieStore.get(WORKSPACE_COOKIE)?.value ?? null;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date() || session.revokedAt) {
    if (session && session.expiresAt < new Date() && !session.revokedAt) {
      await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    }
    return null;
  }

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    sessionId: session.id,
    totpEnabled: Boolean(session.user.totpEnabledAt && session.user.totpSecret),
  };
}

export async function destroySession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    await prisma.session
      .delete({ where: { tokenHash: hashToken(token) } })
      .catch(() => undefined);
  }

  cookieStore.delete(SESSION_COOKIE);
  cookieStore.delete(WORKSPACE_COOKIE);
}

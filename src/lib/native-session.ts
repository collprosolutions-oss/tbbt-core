/**
 * Native field session contract.
 *
 * Web sign-in writes an httpOnly `tbbt_session` cookie (see src/lib/auth.ts).
 * A native app cannot safely reuse that cookie jar, and must not embed
 * passwords or copy website credentials. This module issues the SAME
 * hashed Session row the web already uses, then returns the raw token
 * once over HTTPS for the app to store in the OS secure store.
 *
 * Subsequent native requests send `Authorization: Bearer <token>`.
 * Workspace is derived from the caller's own active Membership — never
 * from a client-supplied businessId unless that id is one of those
 * memberships.
 */
import type { MembershipRole, Prisma, PrismaClient } from "@prisma/client";
import {
  createTotpSignInChallenge,
  verifyTotpSignInChallenge,
  AccountSecurityError,
} from "@/lib/account-security";
import { createSecureToken, hashToken, verifyPassword } from "@/lib/auth-crypto";
import { loadActiveWorkspaceMemberships } from "@/lib/business-contact";

type Db = PrismaClient | Prisma.TransactionClient;

export const NATIVE_SESSION_DAYS = 30;
export const NATIVE_AUTHORIZATION_HEADER = "authorization";
export const NATIVE_WORKSPACE_HEADER = "x-tbbt-workspace";

export type NativeViewer = {
  id: string;
  name: string;
  email: string;
  role: MembershipRole;
};

export type NativeWorkspace = {
  businessId: string;
  businessName: string;
  membershipId: string;
  role: MembershipRole;
};

export type NativeFieldAccess = {
  userId: string;
  sessionId: string;
  viewer: NativeViewer;
  workspace: NativeWorkspace;
  businessId: string;
  membershipId: string;
};

export type NativeSignInSuccess = {
  ok: true;
  token: string;
  expiresAt: Date;
  viewer: NativeViewer;
  workspace: NativeWorkspace;
};

export type NativeSignInFailure = {
  ok: false;
  error: string;
  totpRequired?: boolean;
  challengeToken?: string;
};

export type NativeSignInResult = NativeSignInSuccess | NativeSignInFailure;

export function readBearerToken(authorization: string | null | undefined) {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

export function readRequestedWorkspaceId(header: string | null | undefined) {
  const value = header?.trim();
  return value || null;
}

export async function issueNativeSession(
  db: Db,
  userId: string,
  options?: { userAgent?: string | null },
) {
  const token = createSecureToken();
  const expiresAt = new Date(Date.now() + NATIVE_SESSION_DAYS * 24 * 60 * 60 * 1000);
  const rawAgent = options?.userAgent?.trim() || "";
  const userAgent = `TBBT-Field ${rawAgent}`.trim().slice(0, 240) || "TBBT-Field";

  const session = await db.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent,
    },
  });

  return { token, expiresAt, sessionId: session.id };
}

export async function resolveNativeSession(
  db: PrismaClient,
  token: string | null,
) {
  if (!token) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date() || session.revokedAt) {
    if (session && session.expiresAt < new Date() && !session.revokedAt) {
      await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    }
    return null;
  }

  return {
    sessionId: session.id,
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
  };
}

export async function revokeNativeSession(db: PrismaClient, token: string | null) {
  if (!token) return false;
  const result = await db.session.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

export async function resolveNativeFieldAccess(
  db: PrismaClient,
  input: {
    token: string | null;
    requestedBusinessId?: string | null;
  },
): Promise<
  | { ok: true; access: NativeFieldAccess }
  | { ok: false; status: 401 | 403; error: string }
> {
  const session = await resolveNativeSession(db, input.token);
  if (!session) {
    return { ok: false, status: 401, error: "You need to sign in again." };
  }

  const memberships = await loadActiveWorkspaceMemberships(db, session.userId);
  if (memberships.length === 0) {
    return {
      ok: false,
      status: 403,
      error: "This account is not assigned to a business workspace.",
    };
  }

  const requested = input.requestedBusinessId?.trim() || null;
  if (requested && !memberships.some((membership) => membership.businessId === requested)) {
    return { ok: false, status: 403, error: "That workspace is not available." };
  }

  const current =
    memberships.find((membership) => membership.businessId === requested) ?? memberships[0];

  const workspace: NativeWorkspace = {
    businessId: current.businessId,
    businessName: current.business.name,
    membershipId: current.id,
    role: current.role,
  };

  return {
    ok: true,
    access: {
      userId: session.userId,
      sessionId: session.sessionId,
      viewer: {
        id: session.userId,
        name: session.name,
        email: session.email,
        role: current.role,
      },
      workspace,
      businessId: current.businessId,
      membershipId: current.id,
    },
  };
}

export async function signInNativeField(
  db: PrismaClient,
  input: {
    email?: string;
    password?: string;
    challengeToken?: string;
    totpCode?: string;
    userAgent?: string | null;
    requestedBusinessId?: string | null;
  },
): Promise<NativeSignInResult> {
  const challengeToken = input.challengeToken?.trim() ?? "";
  const totpCode = input.totpCode?.trim() ?? "";

  if (challengeToken) {
    try {
      const verified = await verifyTotpSignInChallenge(db, {
        challengeToken,
        code: totpCode,
      });
      return finishNativeSignIn(db, verified.userId, {
        userAgent: input.userAgent,
        requestedBusinessId: input.requestedBusinessId,
      });
    } catch (error) {
      if (error instanceof AccountSecurityError) {
        return {
          ok: false,
          error: error.message,
          totpRequired: true,
          challengeToken,
        };
      }
      throw error;
    }
  }

  const email = input.email?.trim().toLowerCase() ?? "";
  const password = input.password ?? "";
  if (!email || !password) {
    return { ok: false, error: "Email and password are required." };
  }

  const user = await db.user.findUnique({
    where: { email },
    include: {
      memberships: {
        where: { active: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return { ok: false, error: "Email or password is incorrect." };
  }

  if (user.memberships.length === 0) {
    return { ok: false, error: "This account is not assigned to a business workspace." };
  }

  if (user.totpEnabledAt && user.totpSecret) {
    const token = await createTotpSignInChallenge(db, user.id);
    return {
      ok: false,
      error: "Enter a current authenticator or backup code.",
      totpRequired: true,
      challengeToken: token,
    };
  }

  return finishNativeSignIn(db, user.id, {
    userAgent: input.userAgent,
    requestedBusinessId: input.requestedBusinessId,
  });
}

async function finishNativeSignIn(
  db: PrismaClient,
  userId: string,
  options: { userAgent?: string | null; requestedBusinessId?: string | null },
): Promise<NativeSignInResult> {
  const issued = await issueNativeSession(db, userId, { userAgent: options.userAgent });
  const resolved = await resolveNativeFieldAccess(db, {
    token: issued.token,
    requestedBusinessId: options.requestedBusinessId,
  });
  if (!resolved.ok) {
    await revokeNativeSession(db, issued.token);
    return { ok: false, error: resolved.error };
  }
  return {
    ok: true,
    token: issued.token,
    expiresAt: issued.expiresAt,
    viewer: resolved.access.viewer,
    workspace: resolved.access.workspace,
  };
}

/**
 * Owner Gusto connection: OAuth state, encrypted token pair, serialized
 * single-use refresh, disconnect. Does not run payroll or move funds.
 *
 * Refresh tokens are single-use. The connection row is locked with
 * SELECT … FOR UPDATE. The provider call is capped at GUSTO_HTTP_TIMEOUT_MS,
 * under the 20s transaction, and the new pair is written immediately after
 * the response. A network or timeout error keeps the existing ciphertext
 * and CONNECTED. A lost race that already stored a different ciphertext
 * does not mark the connection Needs reconnect.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { createSecureToken, hashToken } from "@/lib/auth-crypto";
import { decryptConnectionToken, encryptConnectionToken } from "@/lib/connection-token-crypto";
import { requirePayrollConnectOwner, type PayrollConnectAccess } from "@/lib/payroll-connect/access";
import { readGustoAvailability } from "@/lib/payroll-connect/config";
import {
  GUSTO_ACCESS_TOKEN_SKEW_SECONDS,
  GUSTO_HTTP_TIMEOUT_MS,
  GUSTO_OAUTH_STATE_TTL_MS,
  GUSTO_PROVIDER,
} from "@/lib/payroll-connect/copy";
import {
  PayrollConnectError,
  isInvalidGrantError,
  shouldKeepConnectionAfterInvalidGrant,
} from "@/lib/payroll-connect/errors";
import { gustoAuthorizeUrl } from "@/lib/payroll-connect/gusto-http";
import { getPayrollProvider } from "@/lib/payroll-connect/provider";
import { ensurePayrollConnectSchema } from "@/lib/payroll-connect/schema";
import type { GustoTokenPair } from "@/lib/payroll-connect/types";

type Db = PrismaClient | Prisma.TransactionClient;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LockedConnection = {
  id: string;
  status: string;
  refreshTokenCiphertext: string | null;
  accessTokenCiphertext: string | null;
  accessTokenExpiresAt: Date | null;
  externalCompanyId: string | null;
};

function expiresAtFromPair(pair: GustoTokenPair, now = Date.now()) {
  const seconds = Math.max(0, pair.expiresIn - GUSTO_ACCESS_TOKEN_SKEW_SECONDS);
  return new Date(now + seconds * 1000);
}

function encryptPair(businessId: string, pair: GustoTokenPair) {
  return {
    accessTokenCiphertext: encryptConnectionToken(GUSTO_PROVIDER, businessId, pair.accessToken),
    refreshTokenCiphertext: encryptConnectionToken(GUSTO_PROVIDER, businessId, pair.refreshToken),
    accessTokenExpiresAt: expiresAtFromPair(pair),
    scopes: pair.scope,
  };
}

async function markNeedsReconnect(tx: Db, businessId: string) {
  await tx.payrollConnection.updateMany({
    where: { businessId, provider: GUSTO_PROVIDER, status: { not: "DISCONNECTED" } },
    data: {
      status: "NEEDS_RECONNECT",
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      accessTokenExpiresAt: null,
      lastError: new PayrollConnectError("NEEDS_RECONNECT").message,
    },
  });
}

function withProviderDeadline<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PayrollConnectError("PROVIDER"));
    }, GUSTO_HTTP_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function persistRotatedPair(
  db: PrismaClient,
  businessId: string,
  previousRefreshCiphertext: string,
  pair: GustoTokenPair,
) {
  const encrypted = encryptPair(businessId, pair);
  return db.$transaction(
    async (tx) => {
      const locked = await lockConnection(tx, businessId);
      if (!locked || locked.status !== "CONNECTED") return false;
      if (locked.refreshTokenCiphertext !== previousRefreshCiphertext) return true;
      const written = await tx.payrollConnection.updateMany({
        where: {
          id: locked.id,
          businessId,
          provider: GUSTO_PROVIDER,
          refreshTokenCiphertext: previousRefreshCiphertext,
        },
        data: {
          status: "CONNECTED",
          lastError: null,
          ...encrypted,
        },
      });
      return written.count === 1;
    },
    { timeout: GUSTO_HTTP_TIMEOUT_MS, maxWait: 5_000 },
  );
}

/**
 * A 401 during import must not erase a pair a concurrent refresh already
 * stored. Clear ciphertext only when the locked row still holds the token
 * that Gusto rejected.
 */
export async function markNeedsReconnectIfTokenUnchanged(
  db: PrismaClient,
  businessId: string,
  accessTokenCiphertext: string,
  refreshTokenCiphertext: string | null,
) {
  return db.$transaction(
    async (tx) => {
      const locked = await lockConnection(tx, businessId);
      if (!locked || locked.status === "DISCONNECTED") return false;
      if (
        locked.accessTokenCiphertext !== accessTokenCiphertext ||
        locked.refreshTokenCiphertext !== refreshTokenCiphertext
      ) {
        return false;
      }
      await markNeedsReconnect(tx, businessId);
      return true;
    },
    { timeout: GUSTO_HTTP_TIMEOUT_MS, maxWait: 5_000 },
  );
}

async function lockConnection(tx: Db, businessId: string) {
  const rows = await tx.$queryRaw<LockedConnection[]>`
    SELECT "id", "status", "refreshTokenCiphertext", "accessTokenCiphertext", "accessTokenExpiresAt", "externalCompanyId"
    FROM "PayrollConnection"
    WHERE "businessId" = ${businessId}
      AND "provider" = ${GUSTO_PROVIDER}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export async function startPayrollProviderConnect(db: Db, access: PayrollConnectAccess) {
  requirePayrollConnectOwner(access);
  await ensurePayrollConnectSchema(db);
  const availability = readGustoAvailability();
  if (!availability.available) throw new PayrollConnectError("NOT_AVAILABLE");
  const rawState = createSecureToken();
  await db.payrollConnectionOAuthState.create({
    data: {
      businessId: access.scope.businessId,
      membershipId: access.workspace.membership.id,
      provider: GUSTO_PROVIDER,
      stateHash: hashToken(rawState),
      expiresAt: new Date(Date.now() + GUSTO_OAUTH_STATE_TTL_MS),
    },
  });
  return {
    authorizeUrl: gustoAuthorizeUrl({
      host: availability.host,
      clientId: availability.clientId,
      redirectUri: availability.redirectUri,
      state: rawState,
    }),
  };
}

export async function completePayrollProviderOAuth(
  db: PrismaClient,
  access: PayrollConnectAccess,
  input: { code: string; state: string },
) {
  requirePayrollConnectOwner(access);
  await ensurePayrollConnectSchema(db);
  const availability = readGustoAvailability();
  if (!availability.available) throw new PayrollConnectError("NOT_AVAILABLE");
  const code = input.code.trim();
  const state = input.state.trim();
  if (!code || !state) throw new PayrollConnectError("STATE_INVALID");

  const stateHash = hashToken(state);
  const row = await db.payrollConnectionOAuthState.findFirst({
    where: { stateHash },
  });
  if (!row || row.provider !== GUSTO_PROVIDER) throw new PayrollConnectError("STATE_INVALID");
  if (row.businessId !== access.scope.businessId) throw new PayrollConnectError("STATE_INVALID");
  if (row.membershipId !== access.workspace.membership.id) throw new PayrollConnectError("STATE_INVALID");
  if (row.consumedAt) throw new PayrollConnectError("STATE_INVALID");
  if (row.expiresAt.getTime() <= Date.now()) throw new PayrollConnectError("STATE_INVALID");

  const consumed = await db.payrollConnectionOAuthState.updateMany({
    where: {
      id: row.id,
      businessId: access.scope.businessId,
      membershipId: access.workspace.membership.id,
      provider: GUSTO_PROVIDER,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) throw new PayrollConnectError("STATE_INVALID");

  const provider = getPayrollProvider();
  let pair: GustoTokenPair;
  try {
    pair = await provider.exchangeAuthorizationCode({
      code,
      redirectUri: availability.redirectUri,
      clientId: availability.clientId,
      clientSecret: availability.clientSecret,
    });
  } catch (error) {
    if (error instanceof PayrollConnectError) throw error;
    throw new PayrollConnectError("PROVIDER");
  }
  const info = await provider.tokenInfo({ accessToken: pair.accessToken });
  if (info.resourceType !== "Company" || !UUID.test(info.companyId)) {
    throw new PayrollConnectError("PROVIDER");
  }
  if (!info.scope.split(/\s+/).includes("payrolls:read")) {
    throw new PayrollConnectError("PROVIDER");
  }

  const businessId = access.scope.businessId;
  const encrypted = encryptPair(businessId, pair);
  try {
    await db.$transaction(async (tx) => {
      const other = await tx.payrollConnection.findFirst({
        where: {
          provider: GUSTO_PROVIDER,
          externalCompanyId: info.companyId,
          status: { not: "DISCONNECTED" },
          businessId: { not: businessId },
        },
        select: { id: true },
      });
      if (other) throw new PayrollConnectError("COMPANY_IN_USE");
      await tx.payrollConnection.upsert({
        where: { businessId_provider: { businessId, provider: GUSTO_PROVIDER } },
        create: {
          businessId,
          provider: GUSTO_PROVIDER,
          externalCompanyId: info.companyId,
          status: "CONNECTED",
          connectedByMembershipId: access.workspace.membership.id,
          disconnectedAt: null,
          lastError: null,
          ...encrypted,
        },
        update: {
          externalCompanyId: info.companyId,
          status: "CONNECTED",
          connectedByMembershipId: access.workspace.membership.id,
          disconnectedAt: null,
          lastError: null,
          ...encrypted,
        },
      });
    });
  } catch (error) {
    if (error instanceof PayrollConnectError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      throw new PayrollConnectError("COMPANY_IN_USE");
    }
    throw new PayrollConnectError("PROVIDER");
  }

  return { status: "CONNECTED" as const, externalCompanyId: info.companyId };
}

export async function refreshPayrollConnection(db: PrismaClient, access: PayrollConnectAccess) {
  requirePayrollConnectOwner(access);
  await ensurePayrollConnectSchema(db);
  const availability = readGustoAvailability();
  if (!availability.available) throw new PayrollConnectError("NOT_AVAILABLE");
  const businessId = access.scope.businessId;

  let receivedPair: GustoTokenPair | null = null;
  let previousRefreshCiphertext: string | null = null;
  let outcome: { kind: "ok"; rotated: boolean } | { kind: "needs_reconnect" };
  try {
    outcome = await db.$transaction(
      async (tx) => {
        const row = await lockConnection(tx, businessId);
        if (!row || row.status !== "CONNECTED") throw new PayrollConnectError("NOT_CONNECTED");
        access.assertOwned({ businessId, id: row.id });
        const expiresAt = row.accessTokenExpiresAt ? new Date(row.accessTokenExpiresAt) : null;
        const stillFresh =
          expiresAt instanceof Date &&
          !Number.isNaN(expiresAt.getTime()) &&
          expiresAt.getTime() > Date.now() + GUSTO_ACCESS_TOKEN_SKEW_SECONDS * 1000 &&
          Boolean(row.accessTokenCiphertext);
        if (stillFresh) return { kind: "ok" as const, rotated: false };
        if (!row.refreshTokenCiphertext) {
          await markNeedsReconnect(tx, businessId);
          return { kind: "needs_reconnect" as const };
        }
        let refreshToken = "";
        try {
          refreshToken = decryptConnectionToken(GUSTO_PROVIDER, businessId, row.refreshTokenCiphertext);
        } catch {
          await markNeedsReconnect(tx, businessId);
          return { kind: "needs_reconnect" as const };
        }
        let pair: GustoTokenPair;
        try {
          pair = await withProviderDeadline(
            getPayrollProvider().refreshAccessToken({
              refreshToken,
              redirectUri: availability.redirectUri,
              clientId: availability.clientId,
              clientSecret: availability.clientSecret,
            }),
          );
        } catch (error) {
          if (!isInvalidGrantError(error)) {
            throw error instanceof PayrollConnectError ? error : new PayrollConnectError("PROVIDER");
          }
          const again = await lockConnection(tx, businessId);
          if (
            again &&
            shouldKeepConnectionAfterInvalidGrant(
              row.refreshTokenCiphertext ?? "",
              again.refreshTokenCiphertext,
            )
          ) {
            return { kind: "ok" as const, rotated: false };
          }
          await markNeedsReconnect(tx, businessId);
          return { kind: "needs_reconnect" as const };
        }
        receivedPair = pair;
        previousRefreshCiphertext = row.refreshTokenCiphertext;
        const encrypted = encryptPair(businessId, pair);
        const written = await tx.payrollConnection.updateMany({
          where: {
            id: row.id,
            businessId,
            provider: GUSTO_PROVIDER,
            refreshTokenCiphertext: row.refreshTokenCiphertext,
          },
          data: {
            status: "CONNECTED",
            lastError: null,
            ...encrypted,
          },
        });
        if (written.count !== 1) throw new PayrollConnectError("PROVIDER");
        return { kind: "ok" as const, rotated: true };
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
    receivedPair = null;
  } catch (error) {
    if (receivedPair && previousRefreshCiphertext) {
      const saved = await persistRotatedPair(db, businessId, previousRefreshCiphertext, receivedPair);
      if (saved) return { rotated: true };
    }
    if (error instanceof PayrollConnectError) throw error;
    throw new PayrollConnectError("PROVIDER");
  }
  if (outcome.kind === "needs_reconnect") throw new PayrollConnectError("NEEDS_RECONNECT");
  return { rotated: outcome.rotated };
}

export async function disconnectPayrollProvider(db: Db, access: PayrollConnectAccess) {
  requirePayrollConnectOwner(access);
  await ensurePayrollConnectSchema(db);
  const businessId = access.scope.businessId;
  const existing = await db.payrollConnection.findFirst({
    where: { businessId, provider: GUSTO_PROVIDER },
    select: { id: true, businessId: true },
  });
  if (!existing) throw new PayrollConnectError("NOT_CONNECTED");
  access.assertOwned(existing);
  await db.payrollConnection.updateMany({
    where: { id: existing.id, businessId, provider: GUSTO_PROVIDER },
    data: {
      status: "DISCONNECTED",
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      accessTokenExpiresAt: null,
      disconnectedAt: new Date(),
      lastError: null,
    },
  });
}

export async function loadOwnedPayrollConnection(db: Db, access: PayrollConnectAccess) {
  requirePayrollConnectOwner(access);
  await ensurePayrollConnectSchema(db);
  const row = await db.payrollConnection.findFirst({
    where: { businessId: access.scope.businessId, provider: GUSTO_PROVIDER },
  });
  if (!row) return null;
  return access.assertOwned(row);
}

/**
 * OWNER-only connect, status, reconnect, and disconnect for one marketing
 * destination. Nothing in this module creates a publish attempt or calls a
 * publish endpoint. Destination selection is an explicit confirm.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { createSecureToken, hashToken } from "@/lib/auth-crypto";
import {
  ConnectionTokenCryptoError,
  decryptConnectionToken,
  encryptConnectionToken,
} from "@/lib/connection-token-crypto";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  MARKETING_CONNECTION_LABELS,
  MARKETING_OAUTH_STATE_CONSENT,
  MARKETING_OAUTH_STATE_SELECTION,
  MARKETING_OAUTH_STATE_TTL_MS,
  googleOAuthEnv,
  isMarketingConnectionDestination,
  marketingDestinationAvailability,
  marketingTokenPurpose,
  metaOAuthEnv,
  missingScopes,
  type MarketingConnectionDestination,
} from "@/lib/marketing-connections/config";
import { IMPLEMENTED_SOCIAL_PUBLISH_DESTINATIONS } from "@/lib/social-publishing/types";
import { MarketingConnectionError, sanitizeConnectionError } from "@/lib/marketing-connections/errors";
import {
  presentMarketingConnectionCards,
  type MarketingConnectionCard,
  type MarketingConnectionSummary,
} from "@/lib/marketing-connections/presenter";
import {
  resolveMarketingOAuthAdapter,
  type MarketingOAuthAdapter,
  type OAuthCandidate,
} from "@/lib/marketing-connections/providers";
import {
  MARKETING_CONNECTION_SCHEMA_UNAVAILABLE_MESSAGE,
  assertMarketingConnectionSchema,
  isMarketingConnectionSchemaError,
} from "@/lib/marketing-connections/schema-guard";

type Db = PrismaClient | Prisma.TransactionClient;

export type MarketingConnectionDeps = {
  adapter?: MarketingOAuthAdapter;
  now?: () => Date;
};

type SelectionPayload = {
  grantedScopes: string[];
  candidates: OAuthCandidate[];
};

const BLOCKED_PUBLISH_STATUSES = new Set(["DISCONNECTED", "EXPIRED", "NEEDS_RECONNECT", "NOT_CONFIGURED"]);

function nowFrom(deps?: MarketingConnectionDeps) {
  return deps?.now ?? (() => new Date());
}

function requireOwnerConnection(access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.CONNECT_MARKETING_DESTINATIONS);
  if (access.workspace.role !== "OWNER") {
    throw new MarketingConnectionError("Only the OWNER can connect a marketing destination.");
  }
}

function parseDestination(value: string): MarketingConnectionDestination {
  const destination = value.trim();
  if (!isMarketingConnectionDestination(destination)) {
    throw new MarketingConnectionError("That marketing destination is not supported.");
  }
  return destination;
}

async function assertReady(db: Db) {
  try {
    await assertMarketingConnectionSchema(db);
  } catch (error) {
    if (isMarketingConnectionSchemaError(error)) {
      throw new MarketingConnectionError(MARKETING_CONNECTION_SCHEMA_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }
}

function adapterFor(destination: MarketingConnectionDestination, deps?: MarketingConnectionDeps) {
  if (deps?.adapter) {
    if (deps.adapter.destination !== destination) {
      throw new MarketingConnectionError("That provider does not match this destination.");
    }
    return deps.adapter;
  }
  const availability = marketingDestinationAvailability(destination);
  const adapter = resolveMarketingOAuthAdapter(destination);
  if (!adapter) throw new MarketingConnectionError(availability.message);
  return adapter;
}

function redirectUriFor(destination: MarketingConnectionDestination) {
  if (destination === "GOOGLE") return googleOAuthEnv().redirectUri || "https://oauth.fake.test/google/callback";
  return metaOAuthEnv().redirectUri || "https://oauth.fake.test/meta/callback";
}

function encryptFor(destination: MarketingConnectionDestination, businessId: string, value: string | null | undefined) {
  const plaintext = value?.trim() ?? "";
  if (!plaintext) return null;
  try {
    return encryptConnectionToken(marketingTokenPurpose(destination), businessId, plaintext);
  } catch (error) {
    if (error instanceof ConnectionTokenCryptoError) {
      throw new MarketingConnectionError(
        error.message.includes("CONNECTION_TOKEN_ENCRYPTION_KEY")
          ? "Not available: needs CONNECTION_TOKEN_ENCRYPTION_KEY."
          : "The destination token could not be stored.",
      );
    }
    throw error;
  }
}

function decryptFor(destination: string, businessId: string, envelope: string | null | undefined) {
  if (!envelope?.trim()) return "";
  try {
    return decryptConnectionToken(marketingTokenPurpose(destination), businessId, envelope);
  } catch (error) {
    if (error instanceof ConnectionTokenCryptoError) return "";
    throw error;
  }
}

async function issueConsent(
  db: Db,
  access: BusinessAccess,
  destination: MarketingConnectionDestination,
  deps?: MarketingConnectionDeps,
) {
  await assertReady(db);
  const adapter = adapterFor(destination, deps);
  const now = nowFrom(deps)();
  const stateToken = createSecureToken();
  await db.marketingConnectionOAuthState.create({
    data: {
      businessId: access.businessId,
      membershipId: access.workspace.membership.id,
      destination,
      purpose: MARKETING_OAUTH_STATE_CONSENT,
      tokenHash: hashToken(stateToken),
      expiresAt: new Date(now.getTime() + MARKETING_OAUTH_STATE_TTL_MS),
      payloadCiphertext: "",
    },
  });
  return {
    authorizeUrl: adapter.authorizeUrl({
      state: stateToken,
      redirectUri: redirectUriFor(destination),
    }),
    stateToken,
    destination,
  };
}

export async function startMarketingConnection(
  db: Db,
  access: BusinessAccess,
  destinationRaw: string,
  deps?: MarketingConnectionDeps,
) {
  requireOwnerConnection(access);
  const destination = parseDestination(destinationRaw);
  await assertReady(db);
  const existing = await db.marketingSocialDestination.findFirst({
    where: { businessId: access.businessId, destination },
    select: { id: true, connectionStatus: true, accessToken: true },
  });
  const legacy = Boolean(existing && !existing.connectionStatus && existing.accessToken.trim());
  if (existing && existing.connectionStatus !== "DISCONNECTED" && existing.connectionStatus !== "NOT_CONFIGURED") {
    throw new MarketingConnectionError(
      legacy
        ? "This destination has a legacy token. Use reconnect to replace it."
        : "This destination already has a connection record. Use reconnect to replace it.",
    );
  }
  return issueConsent(db, access, destination, deps);
}

export async function reconnectMarketingConnection(
  db: Db,
  access: BusinessAccess,
  destinationRaw: string,
  deps?: MarketingConnectionDeps,
) {
  requireOwnerConnection(access);
  const destination = parseDestination(destinationRaw);
  await assertReady(db);
  const existing = await db.marketingSocialDestination.findFirst({
    where: { businessId: access.businessId, destination },
    select: { id: true },
  });
  if (!existing) {
    throw new MarketingConnectionError("Nothing is connected to reconnect. Use connect first.");
  }
  return issueConsent(db, access, destination, deps);
}

async function consumeState(
  db: Db,
  input: { token: string; purpose: string; destination?: string; now: Date },
) {
  const tokenHash = hashToken(input.token.trim());
  const row = await db.marketingConnectionOAuthState.findFirst({
    where: { tokenHash },
    select: {
      id: true,
      businessId: true,
      membershipId: true,
      destination: true,
      purpose: true,
      expiresAt: true,
      usedAt: true,
      payloadCiphertext: true,
    },
  });
  if (!row || row.purpose !== input.purpose) {
    throw new MarketingConnectionError("That connection attempt is not valid.");
  }
  if (input.destination && row.destination !== input.destination) {
    throw new MarketingConnectionError("That connection attempt does not match this provider.");
  }
  if (row.usedAt) {
    throw new MarketingConnectionError("That connection attempt was already used.");
  }
  if (row.expiresAt.getTime() <= input.now.getTime()) {
    throw new MarketingConnectionError("That connection attempt has expired.");
  }
  const membership = await db.membership.findFirst({
    where: { id: row.membershipId, businessId: row.businessId, active: true },
    select: { id: true, role: true, businessId: true },
  });
  if (!membership || membership.role !== "OWNER" || membership.businessId !== row.businessId) {
    throw new MarketingConnectionError("That connection attempt is not valid.");
  }
  const consumed = await db.marketingConnectionOAuthState.updateMany({
    where: {
      id: row.id,
      businessId: row.businessId,
      purpose: input.purpose,
      usedAt: null,
      expiresAt: { gt: input.now },
    },
    data: { usedAt: input.now },
  });
  if (consumed.count !== 1) {
    throw new MarketingConnectionError("That connection attempt was already used.");
  }
  return row;
}

export type MarketingConnectionCallbackResult =
  | {
      kind: "selection";
      destination: MarketingConnectionDestination;
      selectionToken: string;
      candidates: Array<{ externalId: string; displayName: string }>;
    }
  | {
      kind: "needs_permission";
      destination: MarketingConnectionDestination;
      missing: string[];
    };

export async function completeMarketingConnectionCallback(
  db: Db,
  input: { destinationGroup: "META" | "GOOGLE"; code: string; state: string; providerError?: string },
  deps?: MarketingConnectionDeps,
): Promise<MarketingConnectionCallbackResult> {
  await assertReady(db);
  const now = nowFrom(deps)();
  if (input.providerError?.trim()) {
    throw new MarketingConnectionError("The provider did not grant consent.");
  }
  if (!input.code.trim() || !input.state.trim()) {
    throw new MarketingConnectionError("That connection attempt is not valid.");
  }
  const preview = await db.marketingConnectionOAuthState.findFirst({
    where: { tokenHash: hashToken(input.state.trim()), purpose: MARKETING_OAUTH_STATE_CONSENT },
    select: { destination: true },
  });
  const destination = preview && isMarketingConnectionDestination(preview.destination) ? preview.destination : null;
  if (!destination) throw new MarketingConnectionError("That connection attempt is not valid.");
  if (input.destinationGroup === "GOOGLE" && destination !== "GOOGLE") {
    throw new MarketingConnectionError("That connection attempt does not match this provider.");
  }
  if (input.destinationGroup === "META" && destination === "GOOGLE") {
    throw new MarketingConnectionError("That connection attempt does not match this provider.");
  }
  const state = await consumeState(db, {
    token: input.state,
    purpose: MARKETING_OAUTH_STATE_CONSENT,
    destination,
    now,
  });
  const adapter = adapterFor(destination, deps);
  let exchanged;
  try {
    exchanged = await adapter.exchangeCode({
      code: input.code.trim(),
      redirectUri: redirectUriFor(destination),
    });
  } catch (error) {
    if (error instanceof MarketingConnectionError) throw error;
    throw new MarketingConnectionError("The provider did not complete consent.");
  }
  const missing = missingScopes(destination, exchanged.grantedScopes);
  if (missing.length > 0) {
    await db.marketingSocialDestination.upsert({
      where: { businessId_destination: { businessId: state.businessId, destination } },
      create: {
        businessId: state.businessId,
        destination,
        pageId: "",
        accessToken: "",
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        scopesGranted: exchanged.grantedScopes.join(" "),
        connectionStatus: "NEEDS_RECONNECT",
        lastError: sanitizeConnectionError(`Needs more permission: ${missing.join(", ")}`),
        displayName: "",
        lastCheckedAt: now,
      },
      update: {
        pageId: "",
        accessToken: "",
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        scopesGranted: exchanged.grantedScopes.join(" "),
        connectionStatus: "NEEDS_RECONNECT",
        lastError: sanitizeConnectionError(`Needs more permission: ${missing.join(", ")}`),
        displayName: "",
        tokenExpiresAt: null,
        disconnectedAt: null,
        lastCheckedAt: now,
      },
    });
    return { kind: "needs_permission", destination, missing };
  }
  if (exchanged.candidates.length === 0) {
    throw new MarketingConnectionError(
      destination === "INSTAGRAM"
        ? "No Instagram professional account was linked to a Page you manage."
        : destination === "GOOGLE"
          ? "No Google Business Profile location was returned."
          : "No Facebook Page was returned for this login.",
    );
  }
  const selectionToken = createSecureToken();
  const payload: SelectionPayload = {
    grantedScopes: exchanged.grantedScopes,
    candidates: exchanged.candidates,
  };
  await db.marketingConnectionOAuthState.create({
    data: {
      businessId: state.businessId,
      membershipId: state.membershipId,
      destination,
      purpose: MARKETING_OAUTH_STATE_SELECTION,
      tokenHash: hashToken(selectionToken),
      expiresAt: new Date(now.getTime() + MARKETING_OAUTH_STATE_TTL_MS),
      payloadCiphertext: encryptFor(destination, state.businessId, JSON.stringify(payload)) ?? "",
    },
  });
  return {
    kind: "selection",
    destination,
    selectionToken,
    candidates: exchanged.candidates.map((candidate) => ({
      externalId: candidate.externalId,
      displayName: candidate.displayName,
    })),
  };
}

export async function loadMarketingConnectionSelection(
  db: Db,
  access: BusinessAccess,
  selectionToken: string,
) {
  requireOwnerConnection(access);
  await assertReady(db);
  const row = await db.marketingConnectionOAuthState.findFirst({
    where: {
      tokenHash: hashToken(selectionToken.trim()),
      purpose: MARKETING_OAUTH_STATE_SELECTION,
      businessId: access.businessId,
      membershipId: access.workspace.membership.id,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { destination: true, payloadCiphertext: true, businessId: true },
  });
  if (!row || !isMarketingConnectionDestination(row.destination)) return null;
  access.assertOwned(row);
  const decoded = decodeSelection(row.destination, row.businessId, row.payloadCiphertext);
  if (!decoded) return null;
  return {
    destination: row.destination,
    label: MARKETING_CONNECTION_LABELS[row.destination],
    candidates: decoded.candidates.map((candidate) => ({
      externalId: candidate.externalId,
      displayName: candidate.displayName,
    })),
  };
}

function decodeSelection(destination: string, businessId: string, envelope: string): SelectionPayload | null {
  const json = decryptFor(destination, businessId, envelope);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as SelectionPayload;
    if (!parsed || !Array.isArray(parsed.candidates) || !Array.isArray(parsed.grantedScopes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function confirmMarketingConnectionSelection(
  db: Db,
  access: BusinessAccess,
  input: { selectionToken: string; externalId: string },
  deps?: MarketingConnectionDeps,
) {
  requireOwnerConnection(access);
  await assertReady(db);
  const now = nowFrom(deps)();
  const externalId = input.externalId.trim();
  if (!externalId) {
    throw new MarketingConnectionError("Choose a destination, then confirm. Nothing is selected automatically.");
  }
  const owned = await db.marketingConnectionOAuthState.findFirst({
    where: {
      tokenHash: hashToken(input.selectionToken.trim()),
      purpose: MARKETING_OAUTH_STATE_SELECTION,
      businessId: access.businessId,
      membershipId: access.workspace.membership.id,
    },
    select: { id: true, businessId: true },
  });
  if (!owned) {
    throw new MarketingConnectionError("That connection attempt is not valid.");
  }
  access.assertOwned(owned);
  const state = await consumeState(db, {
    token: input.selectionToken,
    purpose: MARKETING_OAUTH_STATE_SELECTION,
    now,
  });
  if (!isMarketingConnectionDestination(state.destination)) {
    throw new MarketingConnectionError("That marketing destination is not supported.");
  }
  const payload = decodeSelection(state.destination, state.businessId, state.payloadCiphertext);
  await db.marketingConnectionOAuthState.updateMany({
    where: { id: state.id, businessId: state.businessId },
    data: { payloadCiphertext: "" },
  });
  if (!payload) {
    throw new MarketingConnectionError("That connection attempt is not valid.");
  }
  const candidate = payload.candidates.find((item) => item.externalId === externalId);
  if (!candidate) {
    throw new MarketingConnectionError("That destination was not in the list returned for this consent. Nothing was connected.");
  }
  const missing = missingScopes(state.destination, payload.grantedScopes);
  if (missing.length > 0) {
    await db.marketingSocialDestination.upsert({
      where: { businessId_destination: { businessId: access.businessId, destination: state.destination } },
      create: {
        businessId: access.businessId,
        destination: state.destination,
        pageId: "",
        accessToken: "",
        connectionStatus: "NEEDS_RECONNECT",
        lastError: sanitizeConnectionError(`Needs more permission: ${missing.join(", ")}`),
        scopesGranted: payload.grantedScopes.join(" "),
        lastCheckedAt: now,
      },
      update: {
        pageId: "",
        accessToken: "",
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        connectionStatus: "NEEDS_RECONNECT",
        lastError: sanitizeConnectionError(`Needs more permission: ${missing.join(", ")}`),
        scopesGranted: payload.grantedScopes.join(" "),
        tokenExpiresAt: null,
        lastCheckedAt: now,
      },
    });
    return {
      destination: state.destination,
      status: "NEEDS_RECONNECT" as const,
      message: `Needs more permission: ${missing.join(", ")}`,
    };
  }
  await db.marketingSocialDestination.upsert({
    where: { businessId_destination: { businessId: access.businessId, destination: state.destination } },
    create: {
      businessId: access.businessId,
      destination: state.destination,
      pageId: candidate.externalId,
      accessToken: "",
      accessTokenCiphertext: encryptFor(state.destination, access.businessId, candidate.accessToken),
      refreshTokenCiphertext: encryptFor(state.destination, access.businessId, candidate.refreshToken),
      tokenExpiresAt: candidate.expiresAt,
      scopesGranted: payload.grantedScopes.join(" "),
      connectionStatus: "CONNECTED",
      lastError: "",
      displayName: candidate.displayName,
      externalAccountId: candidate.accountId,
      disconnectedAt: null,
      remoteRevokeNote: "",
      lastCheckedAt: now,
      connectedAt: now,
    },
    update: {
      pageId: candidate.externalId,
      accessToken: "",
      accessTokenCiphertext: encryptFor(state.destination, access.businessId, candidate.accessToken),
      refreshTokenCiphertext: encryptFor(state.destination, access.businessId, candidate.refreshToken),
      tokenExpiresAt: candidate.expiresAt,
      scopesGranted: payload.grantedScopes.join(" "),
      connectionStatus: "CONNECTED",
      lastError: "",
      displayName: candidate.displayName,
      externalAccountId: candidate.accountId,
      disconnectedAt: null,
      remoteRevokeNote: "",
      lastCheckedAt: now,
      connectedAt: now,
    },
  });
  return {
    destination: state.destination,
    status: "CONNECTED" as const,
    message: `${MARKETING_CONNECTION_LABELS[state.destination]} connected. Nothing was published.`,
  };
}

function summaryFromRow(row: {
  destination: string;
  pageId: string;
  accessToken: string;
  accessTokenCiphertext: string | null;
  connectionStatus: string;
  displayName: string;
  lastError: string;
  remoteRevokeNote: string;
  disconnectedAt: Date | null;
  scopesGranted: string;
} | null, destination: MarketingConnectionDestination): MarketingConnectionSummary {
  if (!row) {
    return {
      destination,
      connectionStatus: "NOT_CONFIGURED",
      displayName: "",
      lastError: "",
      remoteRevokeNote: "",
      publishable: false,
      legacyPlaintext: false,
      hasRow: false,
    };
  }
  const legacyPlaintext = !row.connectionStatus && Boolean(row.accessToken.trim()) && !row.accessTokenCiphertext;
  const blocked = BLOCKED_PUBLISH_STATUSES.has(row.connectionStatus) || Boolean(row.disconnectedAt);
  const publishable =
    (IMPLEMENTED_SOCIAL_PUBLISH_DESTINATIONS as readonly string[]).includes(destination) &&
    Boolean(row.pageId.trim()) &&
    !blocked &&
    (row.connectionStatus === "CONNECTED" ? Boolean(row.accessTokenCiphertext) : legacyPlaintext);
  return {
    destination,
    connectionStatus: row.connectionStatus || (legacyPlaintext ? "NEEDS_RECONNECT" : "NOT_CONFIGURED"),
    displayName: row.displayName,
    lastError: row.lastError,
    remoteRevokeNote: row.remoteRevokeNote,
    publishable,
    legacyPlaintext,
    hasRow: true,
  };
}

export async function loadMarketingConnectionSummaries(db: Db, businessId: string) {
  try {
    const rows = await db.marketingSocialDestination.findMany({
      where: { businessId },
      select: {
        destination: true,
        pageId: true,
        accessToken: true,
        accessTokenCiphertext: true,
        connectionStatus: true,
        displayName: true,
        lastError: true,
        remoteRevokeNote: true,
        disconnectedAt: true,
        scopesGranted: true,
      },
    });
    return (["FACEBOOK", "INSTAGRAM", "GOOGLE"] as const).map((destination) =>
      summaryFromRow(
        rows.find((row) => row.destination === destination) ?? null,
        destination,
      ),
    );
  } catch (error) {
    if (isMarketingConnectionSchemaError(error)) {
      return (["FACEBOOK", "INSTAGRAM", "GOOGLE"] as const).map((destination) => summaryFromRow(null, destination));
    }
    throw error;
  }
}

export async function loadMarketingConnectionCards(
  db: Db,
  businessId: string,
  owner: boolean,
): Promise<MarketingConnectionCard[]> {
  const summaries = await loadMarketingConnectionSummaries(db, businessId);
  return presentMarketingConnectionCards({
    summaries,
    availability: {
      FACEBOOK: marketingDestinationAvailability("FACEBOOK"),
      INSTAGRAM: marketingDestinationAvailability("INSTAGRAM"),
      GOOGLE: marketingDestinationAvailability("GOOGLE"),
    },
    owner,
  });
}

export async function checkMarketingConnectionStatus(
  db: Db,
  access: BusinessAccess,
  destinationRaw: string,
  deps?: MarketingConnectionDeps,
) {
  requireOwnerConnection(access);
  const destination = parseDestination(destinationRaw);
  await assertReady(db);
  const now = nowFrom(deps)();
  const row = await db.marketingSocialDestination.findFirst({
    where: { businessId: access.businessId, destination },
  });
  if (!row) throw new MarketingConnectionError("That destination is not connected.");
  access.assertOwned(row);
  if (!row.connectionStatus && row.accessToken.trim() && !row.accessTokenCiphertext) {
    return {
      destination,
      status: "NEEDS_RECONNECT" as const,
      message: "Needs reconnect. The legacy token was not sent to the provider.",
    };
  }
  if (row.connectionStatus === "DISCONNECTED") {
    return { destination, status: "DISCONNECTED" as const, message: "Disconnected." };
  }
  const adapter = adapterFor(destination, deps);
  const accessToken = decryptFor(destination, access.businessId, row.accessTokenCiphertext);
  const refreshToken = decryptFor(destination, access.businessId, row.refreshTokenCiphertext);
  let nextAccess = accessToken;
  let nextRefresh = refreshToken;
  let nextExpiry = row.tokenExpiresAt;
  let granted = row.scopesGranted.split(/\s+/).filter(Boolean);
  if (nextExpiry && nextExpiry.getTime() <= now.getTime()) {
    if (!refreshToken) {
      await db.marketingSocialDestination.updateMany({
        where: { id: row.id, businessId: access.businessId },
        data: {
          connectionStatus: "EXPIRED",
          lastError: "Token expired. Reconnect to replace it.",
          lastCheckedAt: now,
        },
      });
      return { destination, status: "EXPIRED" as const, message: "Token expired. Reconnect to replace it." };
    }
    const refreshed = await adapter.refreshAccessToken({
      refreshToken,
      accessToken,
      externalId: row.pageId,
    });
    if (!refreshed.ok) {
      await db.marketingSocialDestination.updateMany({
        where: { id: row.id, businessId: access.businessId },
        data: {
          connectionStatus: "NEEDS_RECONNECT",
          lastError: sanitizeConnectionError(refreshed.error, [accessToken, refreshToken]),
          lastCheckedAt: now,
        },
      });
      return {
        destination,
        status: "NEEDS_RECONNECT" as const,
        message: "Needs reconnect. The token could not be refreshed.",
      };
    }
    nextAccess = refreshed.accessToken;
    nextRefresh = refreshed.refreshToken ?? refreshToken;
    nextExpiry = refreshed.expiresAt;
    granted = refreshed.grantedScopes.length > 0 ? refreshed.grantedScopes : granted;
    await db.marketingSocialDestination.updateMany({
      where: { id: row.id, businessId: access.businessId },
      data: {
        accessToken: "",
        accessTokenCiphertext: encryptFor(destination, access.businessId, nextAccess),
        refreshTokenCiphertext: encryptFor(destination, access.businessId, nextRefresh),
        tokenExpiresAt: nextExpiry,
        scopesGranted: granted.join(" "),
        connectionStatus: "CONNECTED",
        lastError: "",
        lastCheckedAt: now,
      },
    });
  }
  const inspected = await adapter.inspectAccessToken({ accessToken: nextAccess });
  if (!inspected.ok) {
    await db.marketingSocialDestination.updateMany({
      where: { id: row.id, businessId: access.businessId },
      data: {
        connectionStatus: "NEEDS_RECONNECT",
        lastError: sanitizeConnectionError(inspected.error ?? "Token check failed.", [nextAccess, nextRefresh]),
        lastCheckedAt: now,
      },
    });
    return { destination, status: "NEEDS_RECONNECT" as const, message: "Needs reconnect. The token is not valid." };
  }
  const scopes = inspected.grantedScopes.length > 0 ? inspected.grantedScopes : granted;
  const missing = missingScopes(destination, scopes);
  if (missing.length > 0) {
    await db.marketingSocialDestination.updateMany({
      where: { id: row.id, businessId: access.businessId },
      data: {
        connectionStatus: "NEEDS_RECONNECT",
        scopesGranted: scopes.join(" "),
        lastError: sanitizeConnectionError(`Needs more permission: ${missing.join(", ")}`),
        lastCheckedAt: now,
      },
    });
    return {
      destination,
      status: "NEEDS_RECONNECT" as const,
      message: `Needs more permission: ${missing.join(", ")}`,
    };
  }
  await db.marketingSocialDestination.updateMany({
    where: { id: row.id, businessId: access.businessId },
    data: {
      connectionStatus: "CONNECTED",
      scopesGranted: scopes.join(" "),
      lastError: "",
      lastCheckedAt: now,
      accessToken: "",
    },
  });
  return { destination, status: "CONNECTED" as const, message: `${MARKETING_CONNECTION_LABELS[destination]} is connected. Nothing was published.` };
}

export async function disconnectMarketingConnection(
  db: Db,
  access: BusinessAccess,
  destinationRaw: string,
  deps?: MarketingConnectionDeps,
) {
  requireOwnerConnection(access);
  const destination = parseDestination(destinationRaw);
  await assertReady(db);
  const now = nowFrom(deps)();
  const row = await db.marketingSocialDestination.findFirst({
    where: { businessId: access.businessId, destination },
  });
  if (!row) throw new MarketingConnectionError("That destination is not connected.");
  access.assertOwned(row);
  const accessToken = decryptFor(destination, access.businessId, row.accessTokenCiphertext);
  const refreshToken = decryptFor(destination, access.businessId, row.refreshTokenCiphertext);
  let note = "No remote token was stored. Local tokens were wiped.";
  if (accessToken || refreshToken || row.accessToken.trim()) {
    try {
      const adapter = adapterFor(destination, deps);
      const revoked = await adapter.revoke({
        accessToken: accessToken || row.accessToken,
        refreshToken: refreshToken || null,
      });
      note = sanitizeConnectionError(revoked.note, [accessToken, refreshToken, row.accessToken]);
    } catch (error) {
      note = sanitizeConnectionError(
        error instanceof MarketingConnectionError
          ? `${error.message} Local tokens were wiped.`
          : "Remote revoke did not complete. Local tokens were wiped.",
        [accessToken, refreshToken, row.accessToken],
      );
    }
  }
  await db.marketingSocialDestination.updateMany({
    where: { id: row.id, businessId: access.businessId },
    data: {
      accessToken: "",
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      tokenExpiresAt: null,
      connectionStatus: "DISCONNECTED",
      disconnectedAt: now,
      lastError: "",
      remoteRevokeNote: note,
      lastCheckedAt: now,
    },
  });
  return { destination, status: "DISCONNECTED" as const, message: note };
}

export function publishableSocialDestinations(summaries: readonly MarketingConnectionSummary[]) {
  return summaries.filter((row) => row.publishable).map((row) => row.destination);
}

export async function resolveConnectedPublishToken(
  db: Db,
  businessId: string,
  destination: string,
): Promise<{ pageId: string; accessToken: string; externalAccountId: string } | null> {
  const row = await db.marketingSocialDestination.findFirst({
    where: { businessId, destination },
    select: {
      pageId: true,
      accessToken: true,
      accessTokenCiphertext: true,
      connectionStatus: true,
      disconnectedAt: true,
      scopesGranted: true,
      externalAccountId: true,
    },
  });
  if (!row?.pageId?.trim()) return null;
  if (row.disconnectedAt || BLOCKED_PUBLISH_STATUSES.has(row.connectionStatus)) return null;
  const externalAccountId = (row.externalAccountId ?? "").trim();
  if (row.connectionStatus === "CONNECTED") {
    const token = decryptFor(destination, businessId, row.accessTokenCiphertext);
    if (!token) return null;
    const granted = row.scopesGranted.split(/\s+/).filter(Boolean);
    if (isMarketingConnectionDestination(destination) && granted.length > 0 && missingScopes(destination, granted).length > 0) {
      return null;
    }
    return { pageId: row.pageId.trim(), accessToken: token, externalAccountId };
  }
  if (!row.connectionStatus && row.accessToken.trim()) {
    return { pageId: row.pageId.trim(), accessToken: row.accessToken, externalAccountId };
  }
  return null;
}

export async function markMarketingConnectionNeedsReconnect(
  db: Db,
  businessId: string,
  destination: string,
  lastError: string,
) {
  await db.marketingSocialDestination.updateMany({
    where: { businessId, destination },
    data: {
      connectionStatus: "NEEDS_RECONNECT",
      lastError: sanitizeConnectionError(lastError),
      lastCheckedAt: new Date(),
    },
  });
}

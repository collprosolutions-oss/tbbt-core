/**
 * Register and revoke native device tokens for the caller's active
 * membership. Tokens are never accepted for another business or an
 * inactive membership. Opt-in is per device on that membership.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { hashToken } from "@/lib/auth-crypto";
import type { NativeFieldAccess } from "@/lib/native-session";
import { NATIVE_SESSION_TOO_LARGE } from "@/lib/native-session-limits";
import {
  isExpoNativePushConfigured,
  isFakeNativePushAdapterEnabled,
} from "@/lib/native-push/config";
import { isExpoPushToken } from "@/lib/native-push/expo";
import { NATIVE_PUSH_ALERT_DISCLAIMER } from "@/lib/native-push/payload";
import { ensureNativePushSchema, nativePushDeviceTablePresent } from "@/lib/native-push/schema";
import {
  NATIVE_PUSH_PLATFORMS,
  type NativePushPlatform,
} from "@/lib/native-push/types";
import { isRequestPathSchemaUnavailableError } from "@/lib/request-path-schema";

type Db = PrismaClient | Prisma.TransactionClient;

export const NATIVE_PUSH_JSON_MAX_BYTES = 4096;
export const NATIVE_PUSH_TOKEN_MIN_CHARS = 8;
export const NATIVE_PUSH_TOKEN_MAX_CHARS = 4096;
export const NATIVE_PUSH_DEVICE_UNAVAILABLE = "Job alerts are not available.";
export const NATIVE_PUSH_MEMBERSHIP_INACTIVE = "That workspace is not available.";
export const NATIVE_PUSH_DEVICE_NOT_OWNED = "That device is not on this workspace.";
export const NATIVE_PUSH_TOKEN_REQUIRED = "A device token is required.";
export const NATIVE_PUSH_EXPO_TOKEN_REQUIRED =
  "Job alerts need an Expo push token from this device.";
export const NATIVE_PUSH_PLATFORM_REQUIRED = "Choose a device platform.";
export const NATIVE_PUSH_DEVICE_TOKEN_HEADER = "x-tbbt-device-token";

export type NativePushDeviceSummary = {
  id: string;
  platform: string;
  tokenLast4: string;
  optedIn: boolean;
  revokedAt: string | null;
};

export type NativePushPreferencePayload = {
  optedIn: boolean;
  thisDeviceOptedIn: boolean;
  informational: true;
  startsTime: false;
  acceptsAppointment: false;
  disclaimer: string;
  devices: NativePushDeviceSummary[];
};

export type NativePushDeviceWriteResult =
  | { ok: true; preference: NativePushPreferencePayload }
  | { ok: false; status: number; error: string };

function tokenLast4(token: string) {
  return token.slice(-4);
}

export function hashNativePushDeviceToken(token: string) {
  return hashToken(token);
}

export function isNativePushPlatform(value: unknown): value is NativePushPlatform {
  return typeof value === "string" && (NATIVE_PUSH_PLATFORMS as readonly string[]).includes(value);
}

/** Android DELETE can drop a JSON body; GET already uses the header. */
export function readNativePushDeviceTokenFromParts(input: {
  headerToken?: string | null;
  bodyToken?: unknown;
}) {
  const body = typeof input.bodyToken === "string" ? input.bodyToken.trim() : "";
  const header = typeof input.headerToken === "string" ? input.headerToken.trim() : "";
  return body || header;
}

export function parseNativePushDeviceJson(text: string):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; status: 400 | 413; error: string } {
  if (!text.trim()) {
    return { ok: false, status: 400, error: NATIVE_PUSH_TOKEN_REQUIRED };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: NATIVE_PUSH_TOKEN_REQUIRED };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: NATIVE_PUSH_TOKEN_REQUIRED };
  }
  const payload = parsed as Record<string, unknown>;
  if (typeof payload.token === "string" && payload.token.length > NATIVE_PUSH_TOKEN_MAX_CHARS) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }
  return { ok: true, payload };
}

function readToken(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function validateToken(token: string) {
  if (!token || token.length < NATIVE_PUSH_TOKEN_MIN_CHARS) {
    return NATIVE_PUSH_TOKEN_REQUIRED;
  }
  if (token.length > NATIVE_PUSH_TOKEN_MAX_CHARS) {
    return NATIVE_SESSION_TOO_LARGE;
  }
  return null;
}

function validateTokenForConnectedProvider(token: string) {
  const basic = validateToken(token);
  if (basic) return basic;
  if (isFakeNativePushAdapterEnabled()) return null;
  if (isExpoNativePushConfigured() && !isExpoPushToken(token)) {
    return NATIVE_PUSH_EXPO_TOKEN_REQUIRED;
  }
  return null;
}

export function emptyNativePushPreference(): NativePushPreferencePayload {
  return {
    optedIn: false,
    thisDeviceOptedIn: false,
    informational: true,
    startsTime: false,
    acceptsAppointment: false,
    disclaimer: NATIVE_PUSH_ALERT_DISCLAIMER,
    devices: [],
  };
}

function toSummary(row: {
  id: string;
  platform: string;
  tokenLast4: string;
  optedIn: boolean;
  revokedAt: Date | null;
}): NativePushDeviceSummary {
  return {
    id: row.id,
    platform: row.platform,
    tokenLast4: row.tokenLast4,
    optedIn: row.optedIn,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

async function requireActiveMembership(db: PrismaClient, access: NativeFieldAccess) {
  const membership = await db.membership.findFirst({
    where: {
      id: access.membershipId,
      businessId: access.businessId,
      userId: access.userId,
      active: true,
    },
    select: { id: true },
  });
  if (!membership) {
    return {
      ok: false as const,
      status: 403,
      error: NATIVE_PUSH_MEMBERSHIP_INACTIVE,
    };
  }
  return { ok: true as const };
}

function preferenceFromDevices(
  devices: Array<{
    id: string;
    platform: string;
    tokenLast4: string;
    tokenHash: string;
    optedIn: boolean;
    revokedAt: Date | null;
  }>,
  token?: string | null,
): NativePushPreferencePayload {
  const tokenHash = token ? hashNativePushDeviceToken(token) : null;
  const thisDevice = tokenHash
    ? devices.find((row) => row.tokenHash === tokenHash && !row.revokedAt)
    : undefined;
  const active = devices.filter((row) => !row.revokedAt);
  return {
    optedIn: active.some((row) => row.optedIn),
    thisDeviceOptedIn: Boolean(thisDevice?.optedIn),
    informational: true,
    startsTime: false,
    acceptsAppointment: false,
    disclaimer: NATIVE_PUSH_ALERT_DISCLAIMER,
    devices: devices.map(toSummary),
  };
}

export async function listNativePushPreference(
  db: PrismaClient,
  access: NativeFieldAccess,
  options?: { token?: string | null },
): Promise<NativePushDeviceWriteResult> {
  try {
    await ensureNativePushSchema(db);
  } catch (error) {
    if (isRequestPathSchemaUnavailableError(error)) {
      return { ok: false, status: 503, error: NATIVE_PUSH_DEVICE_UNAVAILABLE };
    }
    throw error;
  }
  const membership = await requireActiveMembership(db, access);
  if (!membership.ok) return membership;
  const devices = await db.nativePushDevice.findMany({
    where: {
      businessId: access.businessId,
      membershipId: access.membershipId,
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      platform: true,
      tokenLast4: true,
      tokenHash: true,
      optedIn: true,
      revokedAt: true,
    },
  });
  return {
    ok: true,
    preference: preferenceFromDevices(devices, options?.token),
  };
}

export async function registerNativePushDevice(
  db: PrismaClient,
  access: NativeFieldAccess,
  input: { token: string; platform: unknown; optedIn?: unknown },
): Promise<NativePushDeviceWriteResult> {
  try {
    await ensureNativePushSchema(db);
  } catch (error) {
    if (isRequestPathSchemaUnavailableError(error)) {
      return { ok: false, status: 503, error: NATIVE_PUSH_DEVICE_UNAVAILABLE };
    }
    throw error;
  }
  const membership = await requireActiveMembership(db, access);
  if (!membership.ok) return membership;
  const token = readToken(input.token);
  const tokenError = validateTokenForConnectedProvider(token);
  if (tokenError) {
    return { ok: false, status: 400, error: tokenError };
  }
  if (!isNativePushPlatform(input.platform)) {
    return { ok: false, status: 400, error: NATIVE_PUSH_PLATFORM_REQUIRED };
  }
  const optedIn = input.optedIn === undefined ? true : input.optedIn === true;
  const tokenHash = hashNativePushDeviceToken(token);
  const now = new Date();
  const session = access.sessionId
    ? await db.session.findFirst({
        where: { id: access.sessionId },
        select: { id: true },
      })
    : null;
  await db.nativePushDevice.updateMany({
    where: {
      tokenHash,
      revokedAt: null,
      membershipId: { not: access.membershipId },
    },
    data: {
      optedIn: false,
      revokedAt: now,
    },
  });
  await db.nativePushDevice.upsert({
    where: {
      membershipId_tokenHash: {
        membershipId: access.membershipId,
        tokenHash,
      },
    },
    create: {
      businessId: access.businessId,
      membershipId: access.membershipId,
      userId: access.userId,
      sessionId: session?.id ?? null,
      platform: input.platform,
      tokenHash,
      tokenLast4: tokenLast4(token),
      deviceToken: token,
      optedIn,
      revokedAt: null,
      lastSeenAt: now,
    },
    update: {
      platform: input.platform,
      tokenLast4: tokenLast4(token),
      deviceToken: token,
      ...(session ? { sessionId: session.id } : {}),
      optedIn,
      revokedAt: null,
      lastSeenAt: now,
    },
  });
  return listNativePushPreference(db, access, { token });
}

export async function updateNativePushDeviceOptIn(
  db: PrismaClient,
  access: NativeFieldAccess,
  input: { token: string; optedIn: unknown },
): Promise<NativePushDeviceWriteResult> {
  try {
    await ensureNativePushSchema(db);
  } catch (error) {
    if (isRequestPathSchemaUnavailableError(error)) {
      return { ok: false, status: 503, error: NATIVE_PUSH_DEVICE_UNAVAILABLE };
    }
    throw error;
  }
  const membership = await requireActiveMembership(db, access);
  if (!membership.ok) return membership;
  const token = readToken(input.token);
  const tokenError = validateToken(token);
  if (tokenError) {
    return { ok: false, status: 400, error: tokenError };
  }
  if (typeof input.optedIn !== "boolean") {
    return { ok: false, status: 400, error: "Choose whether job alerts are on." };
  }
  const updated = await db.nativePushDevice.updateMany({
    where: {
      businessId: access.businessId,
      membershipId: access.membershipId,
      tokenHash: hashNativePushDeviceToken(token),
      revokedAt: null,
    },
    data: {
      optedIn: input.optedIn,
      lastSeenAt: new Date(),
    },
  });
  if (updated.count === 0) {
    return { ok: false, status: 404, error: NATIVE_PUSH_DEVICE_UNAVAILABLE };
  }
  return listNativePushPreference(db, access, { token });
}

export async function revokeNativePushDevice(
  db: PrismaClient,
  access: NativeFieldAccess,
  input: { token: string },
): Promise<NativePushDeviceWriteResult> {
  try {
    await ensureNativePushSchema(db);
  } catch (error) {
    if (isRequestPathSchemaUnavailableError(error)) {
      return { ok: false, status: 503, error: NATIVE_PUSH_DEVICE_UNAVAILABLE };
    }
    throw error;
  }
  const membership = await requireActiveMembership(db, access);
  if (!membership.ok) return membership;
  const token = readToken(input.token);
  const tokenError = validateToken(token);
  if (tokenError) {
    return { ok: false, status: 400, error: tokenError };
  }
  const tokenHash = hashNativePushDeviceToken(token);
  const updated = await db.nativePushDevice.updateMany({
    where: {
      businessId: access.businessId,
      membershipId: access.membershipId,
      tokenHash,
      revokedAt: null,
    },
    data: {
      optedIn: false,
      revokedAt: new Date(),
    },
  });
  if (updated.count === 0) {
    const foreign = await db.nativePushDevice.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        membershipId: { not: access.membershipId },
      },
      select: { id: true },
    });
    if (foreign) {
      return { ok: false, status: 403, error: NATIVE_PUSH_DEVICE_NOT_OWNED };
    }
  }
  return listNativePushPreference(db, access, { token });
}

export async function revokeNativePushDevicesForSessions(
  db: Db,
  sessionIds: string[],
) {
  if (sessionIds.length === 0) return;
  if (!(await nativePushDeviceTablePresent(db))) {
    return;
  }
  await db.nativePushDevice.updateMany({
    where: {
      sessionId: { in: sessionIds },
      revokedAt: null,
    },
    data: {
      optedIn: false,
      revokedAt: new Date(),
    },
  });
}

export async function revokeActiveNativePushDevicesForMembership(
  db: Db,
  input: { businessId: string; membershipId: string },
) {
  if (!(await nativePushDeviceTablePresent(db))) {
    return;
  }
  await db.nativePushDevice.updateMany({
    where: {
      businessId: input.businessId,
      membershipId: input.membershipId,
      revokedAt: null,
    },
    data: {
      optedIn: false,
      revokedAt: new Date(),
    },
  });
}

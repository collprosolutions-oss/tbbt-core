import { nativeJson } from "@/lib/native-http";
import {
  listNativePushPreference,
  parseNativePushDeviceJson,
  readNativePushDeviceTokenFromParts,
  registerNativePushDevice,
  revokeNativePushDevice,
  updateNativePushDeviceOptIn,
  NATIVE_PUSH_DEVICE_TOKEN_HEADER,
  NATIVE_PUSH_JSON_MAX_BYTES,
  NATIVE_PUSH_TOKEN_REQUIRED,
} from "@/lib/native-push/devices";
import {
  NATIVE_WORKSPACE_HEADER,
  readBearerToken,
  readRequestedWorkspaceId,
  resolveNativeFieldAccess,
} from "@/lib/native-session";
import { readCappedRequestText } from "@/lib/native-session-limits";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveAccess(request: Request) {
  return resolveNativeFieldAccess(prisma, {
    token: readBearerToken(request.headers.get("authorization")),
    requestedBusinessId: readRequestedWorkspaceId(request.headers.get(NATIVE_WORKSPACE_HEADER)),
  });
}

async function readDevicePayload(request: Request) {
  const capped = await readCappedRequestText(request, NATIVE_PUSH_JSON_MAX_BYTES);
  if (!capped.ok) {
    return capped;
  }
  return parseNativePushDeviceJson(capped.text);
}

export async function GET(request: Request) {
  const resolved = await resolveAccess(request);
  if (!resolved.ok) {
    return nativeJson({ error: resolved.error }, resolved.status);
  }
  const token = request.headers.get(NATIVE_PUSH_DEVICE_TOKEN_HEADER);
  const result = await listNativePushPreference(prisma, resolved.access, { token });
  if (!result.ok) {
    return nativeJson({ error: result.error }, result.status);
  }
  return nativeJson(result.preference);
}

export async function POST(request: Request) {
  const resolved = await resolveAccess(request);
  if (!resolved.ok) {
    return nativeJson({ error: resolved.error }, resolved.status);
  }
  const parsed = await readDevicePayload(request);
  if (!parsed.ok) {
    return nativeJson({ error: parsed.error }, parsed.status);
  }
  const result = await registerNativePushDevice(prisma, resolved.access, {
    token: typeof parsed.payload.token === "string" ? parsed.payload.token : "",
    platform: parsed.payload.platform,
    optedIn: parsed.payload.optedIn,
  });
  if (!result.ok) {
    return nativeJson({ error: result.error }, result.status);
  }
  return nativeJson(result.preference);
}

export async function PATCH(request: Request) {
  const resolved = await resolveAccess(request);
  if (!resolved.ok) {
    return nativeJson({ error: resolved.error }, resolved.status);
  }
  const parsed = await readDevicePayload(request);
  if (!parsed.ok) {
    return nativeJson({ error: parsed.error }, parsed.status);
  }
  const result = await updateNativePushDeviceOptIn(prisma, resolved.access, {
    token: typeof parsed.payload.token === "string" ? parsed.payload.token : "",
    optedIn: parsed.payload.optedIn,
  });
  if (!result.ok) {
    return nativeJson({ error: result.error }, result.status);
  }
  return nativeJson(result.preference);
}

export async function DELETE(request: Request) {
  const resolved = await resolveAccess(request);
  if (!resolved.ok) {
    return nativeJson({ error: resolved.error }, resolved.status);
  }
  const headerToken = request.headers.get(NATIVE_PUSH_DEVICE_TOKEN_HEADER);
  const capped = await readCappedRequestText(request, NATIVE_PUSH_JSON_MAX_BYTES);
  if (!capped.ok) {
    return nativeJson({ error: capped.error }, capped.status);
  }
  let bodyToken: unknown;
  if (capped.text.trim()) {
    const parsed = parseNativePushDeviceJson(capped.text);
    if (!parsed.ok && !headerToken?.trim()) {
      return nativeJson({ error: parsed.error }, parsed.status === 413 ? parsed.status : 400);
    }
    if (parsed.ok) {
      bodyToken = parsed.payload.token;
    }
  }
  const token = readNativePushDeviceTokenFromParts({ headerToken, bodyToken });
  if (!token) {
    return nativeJson({ error: NATIVE_PUSH_TOKEN_REQUIRED }, 400);
  }
  const result = await revokeNativePushDevice(prisma, resolved.access, { token });
  if (!result.ok) {
    return nativeJson({ error: result.error }, result.status);
  }
  return nativeJson(result.preference);
}

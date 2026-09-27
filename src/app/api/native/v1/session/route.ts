import { nativeJson } from "@/lib/native-http";
import {
  parseNativeSessionJson,
  readCappedRequestText,
} from "@/lib/native-session-limits";
import {
  NATIVE_WORKSPACE_HEADER,
  readBearerToken,
  readRequestedWorkspaceId,
  resolveNativeFieldAccess,
  revokeNativeSession,
  signInNativeField,
} from "@/lib/native-session";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  const capped = await readCappedRequestText(request);
  if (!capped.ok) {
    return nativeJson({ error: capped.error }, capped.status);
  }
  const parsed = parseNativeSessionJson(capped.text);
  if (!parsed.ok) {
    return nativeJson({ error: parsed.error }, parsed.status);
  }
  const payload = parsed.payload;
  const result = await signInNativeField(prisma, {
    email: readString(payload.email),
    password: readString(payload.password),
    challengeToken: readString(payload.challengeToken),
    totpCode: readString(payload.totpCode),
    userAgent: request.headers.get("user-agent"),
    requestedBusinessId: readRequestedWorkspaceId(request.headers.get(NATIVE_WORKSPACE_HEADER)),
  });

  if (!result.ok) {
    return nativeJson(
      {
        error: result.error,
        totpRequired: result.totpRequired || undefined,
        challengeToken: result.challengeToken,
      },
      401,
    );
  }

  return nativeJson({
    session: {
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
    },
    viewer: result.viewer,
    workspace: result.workspace,
  });
}

export async function GET(request: Request) {
  const resolved = await resolveNativeFieldAccess(prisma, {
    token: readBearerToken(request.headers.get("authorization")),
    requestedBusinessId: readRequestedWorkspaceId(request.headers.get(NATIVE_WORKSPACE_HEADER)),
  });
  if (!resolved.ok) {
    return nativeJson({ error: resolved.error }, resolved.status);
  }
  return nativeJson({
    viewer: resolved.access.viewer,
    workspace: resolved.access.workspace,
  });
}

export async function DELETE(request: Request) {
  const token = readBearerToken(request.headers.get("authorization"));
  if (!token) {
    return nativeJson({ error: "You need to sign in again." }, 401);
  }
  await revokeNativeSession(prisma, token);
  return nativeJson({ ok: true });
}

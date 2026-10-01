import { nativeJson } from "@/lib/native-http";
import {
  NATIVE_WORKSPACE_HEADER,
  readBearerToken,
  readRequestedWorkspaceId,
  resolveNativeFieldAccess,
} from "@/lib/native-session";
import { readCappedRequestText } from "@/lib/native-session-limits";
import {
  NATIVE_TIME_CARD_JSON_MAX_BYTES,
  parseNativeTimeCorrectionJson,
  requestNativeTimeCorrection,
} from "@/lib/native-time-cards";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const resolved = await resolveNativeFieldAccess(prisma, {
    token: readBearerToken(request.headers.get("authorization")),
    requestedBusinessId: readRequestedWorkspaceId(request.headers.get(NATIVE_WORKSPACE_HEADER)),
  });
  if (!resolved.ok) {
    return nativeJson({ error: resolved.error }, resolved.status);
  }

  const capped = await readCappedRequestText(request, NATIVE_TIME_CARD_JSON_MAX_BYTES);
  if (!capped.ok) {
    return nativeJson({ error: capped.error }, capped.status);
  }
  const parsed = parseNativeTimeCorrectionJson(capped.text);
  if (!parsed.ok) {
    return nativeJson({ error: parsed.error }, parsed.status);
  }

  const result = await requestNativeTimeCorrection(prisma, resolved.access, parsed.input);
  if (!result.ok) {
    return nativeJson({ error: result.error }, result.status);
  }
  return nativeJson({
    timeCards: result.timeCards,
    request: result.request,
    message: result.message,
  });
}

import { nativeJson } from "@/lib/native-http";
import {
  NATIVE_TIME_CARD_SYNC_JSON_MAX_BYTES,
  parseNativeTimeCardSyncJson,
  syncNativeAssignedTimeCardDraft,
} from "@/lib/native-field-time-sync";
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

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const resolved = await resolveNativeFieldAccess(prisma, {
    token: readBearerToken(request.headers.get("authorization")),
    requestedBusinessId: readRequestedWorkspaceId(request.headers.get(NATIVE_WORKSPACE_HEADER)),
  });
  if (!resolved.ok) {
    return nativeJson({ error: resolved.error }, resolved.status);
  }

  const capped = await readCappedRequestText(request, NATIVE_TIME_CARD_SYNC_JSON_MAX_BYTES);
  if (!capped.ok) {
    return nativeJson({ error: capped.error }, capped.status);
  }
  const parsed = parseNativeTimeCardSyncJson(capped.text);
  if (!parsed.ok) {
    return nativeJson({ error: parsed.error }, parsed.status);
  }

  const { jobId } = await context.params;
  const result = await syncNativeAssignedTimeCardDraft(
    prisma,
    resolved.access,
    jobId,
    {
      expectedFingerprint: parsed.expectedFingerprint,
      intents: parsed.intents,
    },
  );
  if (!result.ok) {
    return nativeJson({ error: result.error }, result.status);
  }
  return nativeJson({
    job: result.job,
    alreadySynced: result.alreadySynced,
  });
}

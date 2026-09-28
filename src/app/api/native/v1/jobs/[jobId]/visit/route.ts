import { nativeJson } from "@/lib/native-http";
import {
  NATIVE_VISIT_JSON_MAX_BYTES,
  parseNativeVisitOutcomeJson,
  recordNativeAssignedVisitOutcome,
} from "@/lib/native-field-visits";
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

  const capped = await readCappedRequestText(request, NATIVE_VISIT_JSON_MAX_BYTES);
  if (!capped.ok) {
    return nativeJson({ error: capped.error }, capped.status);
  }
  const parsed = parseNativeVisitOutcomeJson(capped.text);
  if (!parsed.ok) {
    return nativeJson({ error: parsed.error }, parsed.status);
  }

  const { jobId } = await context.params;
  const result = await recordNativeAssignedVisitOutcome(
    prisma,
    resolved.access,
    jobId,
    parsed.outcomeStatus,
  );
  if (!result.ok) {
    return nativeJson({ error: result.error }, result.status);
  }
  return nativeJson({
    job: result.job,
    alreadyRecorded: result.alreadyRecorded,
  });
}

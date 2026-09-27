import { nativeJson } from "@/lib/native-http";
import {
  abortNativeAssignedJobPhoto,
  NATIVE_JOB_PHOTO_JSON_MAX_BYTES,
  parseNativeJobPhotoAbortJson,
} from "@/lib/native-field-photos";
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

  const capped = await readCappedRequestText(request, NATIVE_JOB_PHOTO_JSON_MAX_BYTES);
  if (!capped.ok) {
    return nativeJson({ error: capped.error }, capped.status);
  }
  const parsed = parseNativeJobPhotoAbortJson(capped.text);
  if (!parsed.ok) {
    return nativeJson({ error: parsed.error }, parsed.status);
  }

  const { jobId } = await context.params;
  const result = await abortNativeAssignedJobPhoto(
    prisma,
    resolved.access,
    jobId,
    parsed,
  );
  if (!result.ok) {
    return nativeJson({ error: result.error }, result.status);
  }
  return nativeJson({});
}

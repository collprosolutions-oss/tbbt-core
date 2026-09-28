import { stopNativeAssignedJobRunningTime } from "@/lib/native-field-ops";
import { nativeJson } from "@/lib/native-http";
import {
  NATIVE_WORKSPACE_HEADER,
  readBearerToken,
  readRequestedWorkspaceId,
  resolveNativeFieldAccess,
} from "@/lib/native-session";
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

  const { jobId } = await context.params;
  const result = await stopNativeAssignedJobRunningTime(prisma, resolved.access, jobId);
  if (!result.ok) {
    return nativeJson({ error: result.error }, result.status);
  }
  return nativeJson({
    job: result.job,
    alreadyStopped: result.alreadyStopped,
  });
}

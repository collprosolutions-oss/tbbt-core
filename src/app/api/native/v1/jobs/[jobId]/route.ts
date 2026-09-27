import { loadNativeAssignedJob } from "@/lib/native-field";
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

export async function GET(
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
  const job = await loadNativeAssignedJob(prisma, resolved.access, jobId);
  if (!job) {
    return nativeJson({ error: "That job is not available." }, 404);
  }
  return nativeJson({ job });
}

"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";

export type JobProblemReportActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * OWNER/ADMIN-only: marks a field problem report RESOLVED. Purely an
 * internal status change -- never touches Job status, approved scope,
 * price, or the Invoice. Gated by CAPABILITIES.OPERATE_JOBS, the same
 * hands-on-fieldwork capability that already governs Job start/complete and
 * Job Photos, since resolving a field report is the same kind of ordinary
 * field-operations bookkeeping.
 */
export async function resolveJobProblemReport(
  _prev: JobProblemReportActionState,
  formData: FormData,
): Promise<JobProblemReportActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.OPERATE_JOBS);
  const reportId = readString(formData, "reportId");

  if (!reportId) {
    return { error: "That report could not be found." };
  }

  const report = access.assertOwned(
    await prisma.jobProblemReport.findFirst({
      where: { id: reportId, ...access.scope },
    }),
  );

  if (report.status !== "OPEN") {
    return {};
  }

  const updated = await prisma.jobProblemReport.updateMany({
    where: { id: report.id, businessId: access.businessId, status: "OPEN" },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });

  if (updated.count !== 1) {
    return { error: "That report has already been handled." };
  }

  revalidatePath(`/jobs/${report.jobId}`);
  return {};
}

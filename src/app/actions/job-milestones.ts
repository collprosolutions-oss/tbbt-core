"use server";

import { revalidatePath } from "next/cache";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";
import {
  completeJobMilestone,
  jobMilestoneErrorMessage,
  parseRecordedMilestoneFormItems,
  recordJobMilestones,
  setJobMilestoneCustomerVisible,
} from "@/lib/job-milestone-ops";
import { prisma } from "@/lib/prisma";

export type JobMilestoneActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateMilestoneSurfaces(job: { id: string; projectToken: string }) {
  revalidatePath(`/jobs/${job.id}`);
  revalidatePath(`/p/${job.projectToken}`);
}

export async function recordJobMilestonesAction(
  _prev: JobMilestoneActionState,
  formData: FormData,
): Promise<JobMilestoneActionState> {
  const operating = await requireOperatingProductAccessForForm(
    PRODUCT_CAPABILITIES.JOBS_TASKS,
  );
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  const jobId = readString(formData, "jobId");

  try {
    const items = parseRecordedMilestoneFormItems(formData);
    const result = await recordJobMilestones(prisma, access, { jobId, items });
    const job = access.assertOwned(
      await prisma.job.findFirst({
        where: { id: jobId, businessId: access.businessId },
        select: { id: true, businessId: true, projectToken: true },
      }),
    );
    revalidateMilestoneSurfaces(job);
    return { message: result.message };
  } catch (error) {
    return {
      error: jobMilestoneErrorMessage(error, "Could not record those milestones."),
    };
  }
}

export async function completeJobMilestoneAction(
  _prev: JobMilestoneActionState,
  formData: FormData,
): Promise<JobMilestoneActionState> {
  const operating = await requireOperatingProductAccessForForm(
    PRODUCT_CAPABILITIES.JOBS_TASKS,
  );
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  const milestoneId = readString(formData, "milestoneId");

  try {
    const result = await completeJobMilestone(prisma, access, milestoneId);
    const job = access.assertOwned(
      await prisma.job.findFirst({
        where: { id: result.milestone.jobId, businessId: access.businessId },
        select: { id: true, businessId: true, projectToken: true },
      }),
    );
    revalidateMilestoneSurfaces(job);
    return { message: result.message };
  } catch (error) {
    return {
      error: jobMilestoneErrorMessage(error, "Could not mark that milestone complete."),
    };
  }
}

export async function setJobMilestoneCustomerVisibleAction(
  _prev: JobMilestoneActionState,
  formData: FormData,
): Promise<JobMilestoneActionState> {
  const operating = await requireOperatingProductAccessForForm(
    PRODUCT_CAPABILITIES.JOBS_TASKS,
  );
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  const milestoneId = readString(formData, "milestoneId");
  const customerVisible = readString(formData, "customerVisible") === "1";

  try {
    const result = await setJobMilestoneCustomerVisible(prisma, access, {
      milestoneId,
      customerVisible,
    });
    const job = access.assertOwned(
      await prisma.job.findFirst({
        where: { id: result.milestone.jobId, businessId: access.businessId },
        select: { id: true, businessId: true, projectToken: true },
      }),
    );
    revalidateMilestoneSurfaces(job);
    return {};
  } catch (error) {
    return {
      error: jobMilestoneErrorMessage(
        error,
        "Could not update customer visibility.",
      ),
    };
  }
}

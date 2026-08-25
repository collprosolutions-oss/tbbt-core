"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireBusinessAccess } from "@/lib/access";
import { prisma } from "@/lib/prisma";

export type JobActionState = {
  error?: string;
};

export async function createJobFromEstimate(
  _prev: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const access = await requireBusinessAccess();
  const estimateId =
    typeof formData.get("estimateId") === "string"
      ? formData.get("estimateId")!.toString().trim()
      : "";

  if (!estimateId) {
    return { error: "That estimate could not become a job." };
  }

  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
    }),
  );

  if (estimate.status !== "APPROVED") {
    return { error: "Only an approved estimate can become a job." };
  }

  const existing = await prisma.job.findFirst({
    where: {
      ...access.scope,
      estimateId: estimate.id,
    },
    select: { id: true },
  });

  if (existing) {
    redirect(`/jobs/${existing.id}`);
  }

  let propertyId: string | null = null;
  if (estimate.propertyId) {
    const property = await prisma.property.findFirst({
      where: {
        id: estimate.propertyId,
        ...access.scope,
        ...(estimate.customerId ? { customerId: estimate.customerId } : {}),
      },
    });
    if (property) {
      access.assertOwned(property);
      propertyId = property.id;
    }
  } else if (estimate.serviceRequestId) {
    const serviceRequest = access.assertOwned(
      await prisma.serviceRequest.findFirst({
        where: { id: estimate.serviceRequestId, ...access.scope },
        select: { id: true, businessId: true, propertyId: true },
      }),
    );
    propertyId = serviceRequest.propertyId;
  }

  const job = await prisma.job.create({
    data: {
      businessId: access.businessId,
      customerId: estimate.customerId,
      propertyId,
      estimateId: estimate.id,
      status: "UNSCHEDULED",
    },
  });

  revalidatePath(`/estimates/${estimate.id}`);
  redirect(`/jobs/${job.id}`);
}

export async function scheduleJob(
  jobId: string,
  scheduledAt: string,
): Promise<JobActionState> {
  const access = await requireBusinessAccess();
  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
    }),
  );

  const when = new Date(scheduledAt);
  if (!scheduledAt.trim() || Number.isNaN(when.getTime())) {
    return { error: "Choose a valid date and time." };
  }

  await prisma.job.update({
    where: { id: job.id },
    data: {
      scheduledAt: when,
      status: "SCHEDULED",
    },
  });

  revalidatePath(`/jobs/${job.id}`);
  return {};
}

export async function markJobComplete(jobId: string): Promise<JobActionState> {
  const access = await requireBusinessAccess();
  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
    }),
  );

  await prisma.job.update({
    where: { id: job.id },
    data: { status: "COMPLETED" },
  });

  revalidatePath(`/jobs/${job.id}`);
  return {};
}

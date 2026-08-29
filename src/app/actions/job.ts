"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireBusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  parseDurationMinutes,
  parseScheduleStart,
  schedulesOverlap,
} from "@/lib/job-schedule";
import { formatDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export type JobActionState = {
  error?: string;
  warning?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function createJobFromEstimate(
  _prev: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
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
  revalidatePath("/jobs");
  redirect(`/jobs/${job.id}`);
}

export async function scheduleJob(
  _prev: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  const jobId = readString(formData, "jobId");
  const date = readString(formData, "date");
  const time = readString(formData, "time");
  const durationPreset = readString(formData, "durationPreset");
  const customHours = readString(formData, "customHours");
  const confirmOverlap = readString(formData, "confirmOverlap") === "1";

  if (!jobId) {
    return { error: "That job could not be scheduled." };
  }

  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
    }),
  );

  if (job.status === "COMPLETED") {
    return { error: "A completed job cannot be rescheduled." };
  }

  const start = parseScheduleStart(date, time);
  if (!start) {
    return { error: "Choose a valid date and start time." };
  }

  const duration = parseDurationMinutes(durationPreset, customHours);
  if (!duration.ok) {
    return { error: duration.error };
  }

  if (!confirmOverlap) {
    const others = await prisma.job.findMany({
      where: {
        ...access.scope,
        id: { not: job.id },
        status: { not: "COMPLETED" },
        scheduledAt: { not: null },
      },
      select: {
        scheduledAt: true,
        scheduledDurationMinutes: true,
        customer: { select: { name: true } },
      },
    });

    const overlap = others.find(
      (other) =>
        other.scheduledAt &&
        schedulesOverlap(
          start,
          duration.minutes,
          other.scheduledAt,
          other.scheduledDurationMinutes,
        ),
    );

    if (overlap?.scheduledAt) {
      const who = overlap.customer?.name ?? "another job";
      return {
        warning: `This time overlaps ${who} at ${formatDateTime(overlap.scheduledAt)}. You can schedule anyway if needed.`,
      };
    }
  }

  await prisma.job.update({
    where: { id: job.id },
    data: {
      scheduledAt: start,
      scheduledDurationMinutes: duration.minutes,
      ...(job.status === "UNSCHEDULED" ? { status: "SCHEDULED" } : {}),
    },
  });

  revalidatePath("/jobs");
  revalidatePath("/dashboard");
  revalidatePath(`/jobs/${job.id}`);
  return {};
}

export async function startJob(
  _prev: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.OPERATE_JOBS);
  const jobId = readString(formData, "jobId");

  if (!jobId) {
    return { error: "That job could not be started." };
  }

  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
    }),
  );

  if (job.status === "COMPLETED") {
    return { error: "A completed job cannot be started." };
  }

  if (job.status === "IN_PROGRESS") {
    return {};
  }

  await prisma.job.update({
    where: { id: job.id },
    data: { status: "IN_PROGRESS" },
  });

  revalidatePath("/jobs");
  revalidatePath("/dashboard");
  revalidatePath(`/jobs/${job.id}`);
  return {};
}

export async function markJobComplete(
  _prev: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.OPERATE_JOBS);
  const jobId = readString(formData, "jobId");

  if (!jobId) {
    return { error: "That job could not be completed." };
  }

  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
    }),
  );

  if (job.status === "COMPLETED") {
    return {};
  }

  if (job.status !== "IN_PROGRESS") {
    return { error: "Start the job before completing it." };
  }

  await prisma.job.update({
    where: { id: job.id },
    data: { status: "COMPLETED" },
  });

  revalidatePath("/jobs");
  revalidatePath("/dashboard");
  revalidatePath(`/jobs/${job.id}`);
  return {};
}

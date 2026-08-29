"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

export type RequestAdditionalWorkState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

const MAX_DESCRIPTION_LENGTH = 2000;

/**
 * "+ Request Additional Work" on the Customer Project Portal. This is NOT
 * approval and NEVER creates a ChangeOrder or changes approved scope,
 * price, Job total, or Invoice total by itself -- it only creates an
 * internal review item (AdditionalWorkRequest, status OPEN) that an
 * owner/admin later reviews from the Job/Work Order page and decides to
 * price into a ChangeOrder, handle separately, or dismiss.
 *
 * SECURITY: scoped only by the Job's own unguessable projectToken, exactly
 * like the rest of the Customer Project Portal (see
 * src/app/p/[token]/page.tsx) -- never a client-supplied businessId/jobId.
 */
export async function requestAdditionalWork(
  _prev: RequestAdditionalWorkState,
  formData: FormData,
): Promise<RequestAdditionalWorkState> {
  const token = readString(formData, "projectToken");
  const description = readString(formData, "description").slice(
    0,
    MAX_DESCRIPTION_LENGTH,
  );

  if (!token) {
    return { error: "This project link is not available." };
  }

  if (!description) {
    return { error: "Describe the additional work you'd like." };
  }

  const job = await prisma.job.findUnique({
    where: { projectToken: token },
    select: { id: true, businessId: true },
  });

  if (!job) {
    return { error: "This project link is not available." };
  }

  await prisma.additionalWorkRequest.create({
    data: {
      businessId: job.businessId,
      jobId: job.id,
      description,
      source: "CUSTOMER",
    },
  });

  revalidatePath(`/p/${token}`);
  revalidatePath(`/jobs/${job.id}`);
  return {
    message:
      "Thanks! We received your request and will follow up about pricing and scheduling.",
  };
}

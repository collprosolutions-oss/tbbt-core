"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { prisma } from "@/lib/prisma";

export type JobPhotoActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

const URL_PATTERN = /^https?:\/\/\S+$/i;

export async function addJobPhoto(
  _prev: JobPhotoActionState,
  formData: FormData,
): Promise<JobPhotoActionState> {
  const access = await requireBusinessAccess();
  const jobId = readString(formData, "jobId");
  const stage = readString(formData, "stage");
  const url = readString(formData, "url");
  const caption = readString(formData, "caption");

  if (!jobId) {
    return { error: "That job could not be found." };
  }

  if (stage !== "BEFORE" && stage !== "DURING" && stage !== "AFTER") {
    return { error: "Choose Before, During, or After." };
  }

  if (!url) {
    return { error: "Enter a photo URL." };
  }

  if (!URL_PATTERN.test(url)) {
    return { error: "Enter a valid photo URL starting with http:// or https://." };
  }

  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
    }),
  );

  await prisma.jobPhoto.create({
    data: {
      businessId: access.businessId,
      jobId: job.id,
      stage,
      url,
      caption: caption || null,
    },
  });

  revalidatePath(`/jobs/${job.id}`);
  return {};
}

export async function deleteJobPhoto(
  _prev: JobPhotoActionState,
  formData: FormData,
): Promise<JobPhotoActionState> {
  const access = await requireBusinessAccess();
  const photoId = readString(formData, "photoId");

  if (!photoId) {
    return { error: "That photo could not be found." };
  }

  const photo = access.assertOwned(
    await prisma.jobPhoto.findFirst({
      where: { id: photoId, ...access.scope },
    }),
  );

  await prisma.jobPhoto.delete({ where: { id: photo.id } });

  revalidatePath(`/jobs/${photo.jobId}`);
  return {};
}

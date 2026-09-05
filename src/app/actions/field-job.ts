"use server";

/**
 * Employee Field Workflow server actions (Phase 3 / Step 4).
 *
 * Every action here re-derives the caller's business/membership from the
 * authenticated session (requireFieldWorkspace(), never from client input)
 * and re-fetches the target Job scoped by BOTH that businessId AND
 * assignedMembershipId in one query (findAssignedJob() in
 * src/lib/field-access.ts) -- so a MEMBER can only ever act on a Job that
 * is actually assigned to them, in their own business, regardless of what
 * jobId a crafted request supplies. None of these actions require
 * CAPABILITIES.OPERATE_JOBS (the OWNER/ADMIN, business-wide capability) --
 * this is a parallel, narrower authorization boundary scoped to exactly one
 * assigned Job, per the FIELD ISSUE SECURITY / AUTHORIZATION sections of
 * the spec.
 */
import { revalidatePath } from "next/cache";
import { findAssignedJob } from "@/lib/field-access";
import { evaluateCompleteJob, evaluateStartJob } from "@/lib/job-lifecycle";
import { prisma } from "@/lib/prisma";
import {
  isStorageConfigured,
  isSupportedImageMimeType,
  MAX_JOB_PHOTO_UPLOAD_BYTES,
  uploadJobPhoto,
} from "@/lib/storage";

export type FieldJobActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

const NOT_ASSIGNED_ERROR = "That job isn't assigned to you.";
const MAX_TEXT_LENGTH = 2000;

function revalidateFieldJob(jobId: string) {
  revalidatePath(`/field/jobs/${jobId}`);
  revalidatePath("/field");
}

export async function startAssignedJob(
  _prev: FieldJobActionState,
  formData: FormData,
): Promise<FieldJobActionState> {
  const jobId = readString(formData, "jobId");
  if (!jobId) {
    return { error: "That job could not be found." };
  }

  const { job } = await findAssignedJob(jobId);
  if (!job) {
    return { error: NOT_ASSIGNED_ERROR };
  }

  const result = evaluateStartJob(job.status);
  if (!result.ok) {
    return { error: result.error };
  }

  if (result.nextStatus) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: result.nextStatus },
    });
  }

  revalidateFieldJob(job.id);
  return {};
}

export async function completeAssignedJob(
  _prev: FieldJobActionState,
  formData: FormData,
): Promise<FieldJobActionState> {
  const jobId = readString(formData, "jobId");
  if (!jobId) {
    return { error: "That job could not be found." };
  }

  const { job } = await findAssignedJob(jobId);
  if (!job) {
    return { error: NOT_ASSIGNED_ERROR };
  }

  const result = evaluateCompleteJob(job.status);
  if (!result.ok) {
    return { error: result.error };
  }

  if (result.nextStatus) {
    // Deliberately ONLY flips Job.status. Does not create/send an Invoice,
    // approve any Change Order, or touch payment -- owner financial control
    // stays on Work Order Complete Job (markJobComplete →
    // completeJobAndSendInvoice).
    await prisma.job.update({
      where: { id: job.id },
      data: { status: result.nextStatus },
    });
  }

  revalidateFieldJob(job.id);
  return {};
}

const STORAGE_NOT_CONFIGURED_ERROR =
  "Photo storage isn't set up yet. Ask an admin to connect Vercel Blob (BLOB_READ_WRITE_TOKEN) before uploading job photos.";

export async function addAssignedJobPhoto(
  _prev: FieldJobActionState,
  formData: FormData,
): Promise<FieldJobActionState> {
  const jobId = readString(formData, "jobId");
  const stage = readString(formData, "stage");
  const caption = readString(formData, "caption");
  const file = formData.get("file");

  if (!jobId) {
    return { error: "That job could not be found." };
  }

  if (stage !== "BEFORE" && stage !== "DURING" && stage !== "AFTER") {
    return { error: "Choose Before, During, or After." };
  }

  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a photo to upload." };
  }

  if (!isSupportedImageMimeType(file.type)) {
    return {
      error: "Unsupported file type. Upload a JPEG, PNG, WebP, GIF, or HEIC photo.",
    };
  }

  if (file.size > MAX_JOB_PHOTO_UPLOAD_BYTES) {
    const maxMb = (MAX_JOB_PHOTO_UPLOAD_BYTES / (1024 * 1024)).toFixed(0);
    return { error: `That photo is too large. The limit is ${maxMb} MB.` };
  }

  if (!isStorageConfigured()) {
    return { error: STORAGE_NOT_CONFIGURED_ERROR };
  }

  const { job, businessId } = await findAssignedJob(jobId);
  if (!job) {
    return { error: NOT_ASSIGNED_ERROR };
  }

  let uploaded: { url: string };
  try {
    uploaded = await uploadJobPhoto({ businessId, jobId: job.id, file });
  } catch (error) {
    console.error("Field job photo upload failed", error);
    return { error: "That photo could not be uploaded. Try again." };
  }

  // Uploaded photos remain PRIVATE by default, exactly like the internal
  // Work Order's own uploads (see JobPhoto model doc comment in
  // prisma/schema.prisma) -- an employee upload never grants customer
  // visibility, portfolio, or marketing permission.
  await prisma.jobPhoto.create({
    data: {
      businessId,
      jobId: job.id,
      stage,
      url: uploaded.url,
      caption: caption || null,
    },
  });

  revalidateFieldJob(job.id);
  return {};
}

export async function reportJobProblem(
  _prev: FieldJobActionState,
  formData: FormData,
): Promise<FieldJobActionState> {
  const jobId = readString(formData, "jobId");
  const description = readString(formData, "description").slice(0, MAX_TEXT_LENGTH);

  if (!jobId) {
    return { error: "That job could not be found." };
  }

  if (!description) {
    return { error: "Describe the problem." };
  }

  const { job, businessId, membershipId } = await findAssignedJob(jobId);
  if (!job) {
    return { error: NOT_ASSIGNED_ERROR };
  }

  // membershipId is the caller's OWN membership, derived server-side from
  // the session (see requireFieldWorkspace() in src/lib/field-access.ts) --
  // never accepted as form input, so a report can never be attributed to
  // anyone else.
  await prisma.jobProblemReport.create({
    data: {
      businessId,
      jobId: job.id,
      membershipId,
      description,
    },
  });

  revalidateFieldJob(job.id);
  revalidatePath(`/jobs/${job.id}`);
  return { message: "Problem reported. The office has been notified." };
}

export async function requestAdditionalWorkFromField(
  _prev: FieldJobActionState,
  formData: FormData,
): Promise<FieldJobActionState> {
  const jobId = readString(formData, "jobId");
  const description = readString(formData, "description").slice(0, MAX_TEXT_LENGTH);

  if (!jobId) {
    return { error: "That job could not be found." };
  }

  if (!description) {
    return { error: "Describe what the customer asked for." };
  }

  const { job, businessId } = await findAssignedJob(jobId);
  if (!job) {
    return { error: NOT_ASSIGNED_ERROR };
  }

  // This NEVER changes approved scope, project total, or the invoice, and
  // never creates or approves a Change Order by itself -- it only creates
  // an internal review item (same AdditionalWorkRequest model + OPEN status
  // the Customer Project Portal already uses), tagged source: "EMPLOYEE" so
  // owner/admin can see it came from the field. Owner/admin decides
  // separately whether to price it into a Change Order.
  await prisma.additionalWorkRequest.create({
    data: {
      businessId,
      jobId: job.id,
      description,
      source: "EMPLOYEE",
    },
  });

  revalidateFieldJob(job.id);
  revalidatePath(`/jobs/${job.id}`);
  return {
    message: "Sent to the office. They'll follow up on pricing and scope.",
  };
}

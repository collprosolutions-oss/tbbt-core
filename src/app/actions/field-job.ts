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
import {
  FIELD_JOB_NOT_ASSIGNED,
  FIELD_JOB_PROBLEM_DESCRIPTION_MAX,
  normalizeAssignedJobProblemDescription,
  reportAssignedJobProblem,
  requestAssignedJobAdditionalWork,
  startAssignedFieldJob,
} from "@/lib/field-job-ops";
import { prisma } from "@/lib/prisma";
import {
  requireSaasOperatingEntitlement,
  saasOperatingErrorMessage,
  SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
} from "@/lib/saas-billing/entitlement";
import { ensureAppointmentConfirmationSchema } from "@/lib/appointment-data";
import { completeJobWithRunningTimeSafety } from "@/lib/time-card-ops";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";
import {
  isBusinessStorageConfigured,
  StorageError,
  StorageQuotaError,
} from "@/lib/business-storage";
import {
  abortAssignedFieldJobPhoto,
  authorizeAssignedFieldJobPhoto,
  finalizeAssignedFieldJobPhoto,
} from "@/lib/business-storage/field-job-photos";

export type FieldJobActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

const NOT_ASSIGNED_ERROR = FIELD_JOB_NOT_ASSIGNED;
const MAX_TEXT_LENGTH = FIELD_JOB_PROBLEM_DESCRIPTION_MAX;

async function requireAssignedJobOperating(jobId: string) {
  const result = await findAssignedJob(jobId);
  if (!result.job) {
    return { ...result, error: NOT_ASSIGNED_ERROR };
  }
  try {
    await requireSaasOperatingEntitlement(prisma, result);
  } catch (error) {
    return {
      ...result,
      job: null,
      error: saasOperatingErrorMessage(error) ?? SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
    };
  }
  return { ...result, error: undefined as string | undefined };
}

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

  const assigned = await requireAssignedJobOperating(jobId);
  if (!assigned.job) {
    return { error: assigned.error ?? NOT_ASSIGNED_ERROR };
  }

  await ensureAppointmentConfirmationSchema(prisma);
  const started = await startAssignedFieldJob(
    prisma,
    { businessId: assigned.businessId, membershipId: assigned.membershipId },
    assigned.job.id,
  );
  if (!started.ok) {
    return { error: started.error };
  }

  if (!started.alreadyStarted) {
    await emitAndProcessBusinessEvent(prisma, {
      businessId: started.businessId,
      type: "JOB_STARTED",
      subjectType: "JOB",
      subjectId: started.jobId,
      payload: { customerId: started.customerId },
      idempotencyKey: `JOB_STARTED:${started.jobId}`,
    });
  }

  revalidateFieldJob(started.jobId);
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

  const assigned = await requireAssignedJobOperating(jobId);
  if (!assigned.job) {
    return { error: assigned.error ?? NOT_ASSIGNED_ERROR };
  }
  const { job } = assigned;

  // Deliberately ONLY flips Job.status (after closing RUNNING JOB time).
  // Does not create/send an Invoice, approve any Change Order, or touch
  // payment -- owner financial control stays on Work Order Complete Job
  // (markJobComplete → completeJobAndSendInvoice).
  const result = await completeJobWithRunningTimeSafety(prisma, {
    businessId: job.businessId,
    jobId: job.id,
    actorMembershipId: assigned.membershipId,
  });
  if (!result.ok) {
    return { error: result.error };
  }

  if (!result.alreadyCompleted) {
    await emitAndProcessBusinessEvent(prisma, {
      businessId: job.businessId,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: job.id,
      payload: { customerId: job.customerId },
      idempotencyKey: `JOB_COMPLETED:${job.id}`,
    });
  }

  revalidateFieldJob(job.id);
  return {};
}

const STORAGE_NOT_CONFIGURED_ERROR =
  "Photo storage isn't set up yet. Ask an admin to connect platform file storage (Cloudflare R2) before uploading job photos.";

export type FieldJobPhotoUploadState = FieldJobActionState & {
  assetId?: string;
  uploadUrl?: string;
  uploadHeaders?: Record<string, string>;
  uploadMethod?: "PUT";
};

function fieldPhotoError(error: unknown) {
  if (error instanceof StorageQuotaError || error instanceof StorageError) {
    return error.message;
  }
  return "That photo could not be uploaded. Try again.";
}

async function requireAssignedFieldPhotoJob(jobId: string) {
  if (!jobId) {
    return { error: "That job could not be found.", field: null as null };
  }
  const assigned = await requireAssignedJobOperating(jobId);
  if (!assigned.job) {
    return { error: assigned.error ?? NOT_ASSIGNED_ERROR, field: null as null };
  }
  return {
    error: undefined as string | undefined,
    field: {
      businessId: assigned.businessId,
      membershipId: assigned.membershipId,
      jobId: assigned.job.id,
    },
  };
}

/**
 * Authorizes a browser-direct R2 upload. The image body never enters this
 * server action -- only filename, MIME type, and declared size.
 */
export async function authorizeAssignedJobPhotoUpload(input: {
  jobId: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
}): Promise<FieldJobPhotoUploadState> {
  try {
    if (!isBusinessStorageConfigured()) {
      return { error: STORAGE_NOT_CONFIGURED_ERROR };
    }
    const assigned = await requireAssignedFieldPhotoJob(input.jobId);
    if (!assigned.field) {
      return { error: assigned.error };
    }
    const authorized = await authorizeAssignedFieldJobPhoto(
      { db: prisma },
      assigned.field,
      {
        jobId: assigned.field.jobId,
        originalFilename: input.originalFilename,
        mimeType: input.mimeType,
        fileSizeBytes: input.fileSizeBytes,
      },
    );
    return {
      assetId: authorized.asset.id,
      uploadUrl: authorized.upload.url,
      uploadHeaders: authorized.upload.headers,
      uploadMethod: authorized.upload.method,
    };
  } catch (error) {
    return { error: fieldPhotoError(error) };
  }
}

export async function finalizeAssignedJobPhotoUpload(input: {
  jobId: string;
  assetId: string;
  stage: string;
  caption?: string;
}): Promise<FieldJobPhotoUploadState> {
  try {
    if (input.stage !== "BEFORE" && input.stage !== "DURING" && input.stage !== "AFTER") {
      return { error: "Choose Before, During, or After." };
    }
    const assigned = await requireAssignedFieldPhotoJob(input.jobId);
    if (!assigned.field) {
      return { error: assigned.error };
    }
    await finalizeAssignedFieldJobPhoto({ db: prisma }, assigned.field, {
      jobId: assigned.field.jobId,
      assetId: input.assetId,
      stage: input.stage,
      caption: input.caption,
    });
    revalidateFieldJob(assigned.field.jobId);
    return { message: "Photo added." };
  } catch (error) {
    return { error: fieldPhotoError(error) };
  }
}

export async function abortAssignedJobPhotoUpload(input: {
  jobId: string;
  assetId: string;
}): Promise<FieldJobPhotoUploadState> {
  try {
    const assigned = await requireAssignedFieldPhotoJob(input.jobId);
    if (!assigned.field) {
      return { error: assigned.error };
    }
    await abortAssignedFieldJobPhoto({ db: prisma }, assigned.field, {
      jobId: assigned.field.jobId,
      assetId: input.assetId,
    });
    return {};
  } catch (error) {
    return { error: fieldPhotoError(error) };
  }
}

export async function reportJobProblem(
  _prev: FieldJobActionState,
  formData: FormData,
): Promise<FieldJobActionState> {
  const jobId = readString(formData, "jobId");
  const description = normalizeAssignedJobProblemDescription(
    readString(formData, "description"),
  );

  if (!jobId) {
    return { error: "That job could not be found." };
  }

  if (!description) {
    return { error: "Describe the problem." };
  }

  const assigned = await requireAssignedJobOperating(jobId);
  if (!assigned.job) {
    return { error: assigned.error ?? NOT_ASSIGNED_ERROR };
  }

  // membershipId is the caller's OWN membership, derived server-side from
  // the session (see requireFieldWorkspace() in src/lib/field-access.ts) --
  // never accepted as form input, so a report can never be attributed to
  // anyone else.
  const reported = await reportAssignedJobProblem(
    prisma,
    { businessId: assigned.businessId, membershipId: assigned.membershipId },
    { jobId: assigned.job.id, description },
  );
  if (!reported.ok) {
    return { error: reported.error };
  }

  revalidateFieldJob(assigned.job.id);
  revalidatePath(`/jobs/${assigned.job.id}`);
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

  const assigned = await requireAssignedJobOperating(jobId);
  if (!assigned.job) {
    return { error: assigned.error ?? NOT_ASSIGNED_ERROR };
  }

  // This NEVER changes approved scope, project total, or the invoice, and
  // never creates or approves a Change Order by itself -- it only creates
  // an internal review item (same AdditionalWorkRequest model + OPEN status
  // the Customer Project Portal already uses), tagged source: "EMPLOYEE" so
  // owner/admin can see it came from the field. Owner/admin decides
  // separately whether to price it into a Change Order.
  const requested = await requestAssignedJobAdditionalWork(
    prisma,
    { businessId: assigned.businessId, membershipId: assigned.membershipId },
    { jobId: assigned.job.id, description },
  );
  if (!requested.ok) {
    return { error: requested.error };
  }

  revalidateFieldJob(assigned.job.id);
  revalidatePath(`/jobs/${assigned.job.id}`);
  return {
    message: "Sent to the office. They'll follow up on pricing and scope.",
  };
}

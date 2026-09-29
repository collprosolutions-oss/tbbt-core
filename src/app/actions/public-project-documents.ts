"use server";

import { revalidatePath } from "next/cache";
import {
  abortProjectTokenDocument,
  authorizeProjectTokenDocument,
  finalizeProjectTokenDocument,
} from "@/lib/business-storage/project-documents";
import {
  isBusinessStorageConfigured,
  StorageError,
  StorageQuotaError,
} from "@/lib/business-storage";
import { prisma } from "@/lib/prisma";

export type ProjectDocumentUploadState = {
  error?: string;
  message?: string;
  assetId?: string;
  uploadUrl?: string;
  uploadHeaders?: Record<string, string>;
  uploadMethod?: "PUT";
};

function projectDocumentError(error: unknown) {
  if (error instanceof StorageQuotaError || error instanceof StorageError) {
    return error.message;
  }
  return "That document could not be uploaded.";
}

/**
 * Customer Project Portal document upload. Scoped only by Job.projectToken.
 * The file body never enters this action — only filename, MIME, and size.
 * Never accepts a client-supplied businessId or jobId.
 */
export async function authorizeProjectDocumentUpload(input: {
  projectToken: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
}): Promise<ProjectDocumentUploadState> {
  try {
    if (!isBusinessStorageConfigured()) {
      return { error: "Document upload is not available on this project yet." };
    }
    const authorized = await authorizeProjectTokenDocument(
      { db: prisma },
      input.projectToken,
      {
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
    return { error: projectDocumentError(error) };
  }
}

export async function finalizeProjectDocumentUpload(input: {
  projectToken: string;
  assetId: string;
}): Promise<ProjectDocumentUploadState> {
  try {
    const asset = await finalizeProjectTokenDocument(
      { db: prisma },
      input.projectToken,
      input.assetId,
    );
    revalidatePath(`/p/${input.projectToken.trim()}`);
    if (asset.jobId) {
      revalidatePath(`/jobs/${asset.jobId}`);
    }
    return {
      assetId: asset.id,
      message: "We received your document. The owner will review it.",
    };
  } catch (error) {
    return { error: projectDocumentError(error) };
  }
}

export async function abortProjectDocumentUpload(input: {
  projectToken: string;
  assetId: string;
}): Promise<ProjectDocumentUploadState> {
  try {
    await abortProjectTokenDocument({ db: prisma }, input.projectToken, input.assetId);
    return {};
  } catch (error) {
    return { error: projectDocumentError(error) };
  }
}

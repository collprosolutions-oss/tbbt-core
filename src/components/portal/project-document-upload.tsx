"use client";

import { useState, type FormEvent } from "react";
import {
  abortProjectDocumentUpload,
  authorizeProjectDocumentUpload,
  finalizeProjectDocumentUpload,
} from "@/app/actions/public-project-documents";
import {
  inspectProjectDocumentUpload,
  projectDocumentMaxBytesLabel,
} from "@/lib/business-storage/project-document-rules";
import { PROJECT_DOCUMENT_MAX_COUNT } from "@/lib/business-storage/types";
import { formatStorageBytes } from "@/lib/business-storage/keys";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate } from "@/lib/format";

type ProjectDocumentReceiptItem = {
  id: string;
  originalFilename: string;
  fileSizeBytes: number;
  createdAt: Date;
};

export function ProjectDocumentUpload({
  projectToken,
  documents,
}: {
  projectToken: string;
  documents: ProjectDocumentReceiptItem[];
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const remaining = PROJECT_DOCUMENT_MAX_COUNT - documents.length;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    const file = formData.get("file");

    if (!(file instanceof File) || file.size === 0) {
      setError("Choose a document to upload.");
      return;
    }

    const inspection = inspectProjectDocumentUpload(file);
    if (!inspection.ok) {
      setError(inspection.error);
      return;
    }

    setPending(true);
    setError(null);
    setMessage(null);
    let assetId = "";
    try {
      const authorized = await authorizeProjectDocumentUpload({
        projectToken,
        originalFilename: inspection.fileName,
        mimeType: inspection.mimeType,
        fileSizeBytes: inspection.fileSizeBytes,
      });
      if (authorized.error || !authorized.assetId || !authorized.uploadUrl) {
        setError(authorized.error || "That document could not be authorized.");
        return;
      }
      assetId = authorized.assetId;

      const uploaded = await fetch(authorized.uploadUrl, {
        method: authorized.uploadMethod || "PUT",
        headers: authorized.uploadHeaders,
        body: file,
      });
      if (!uploaded.ok) {
        await abortProjectDocumentUpload({ projectToken, assetId });
        setError("The document could not be uploaded to file storage. Try again.");
        return;
      }

      const finalized = await finalizeProjectDocumentUpload({
        projectToken,
        assetId,
      });
      if (finalized.error) {
        await abortProjectDocumentUpload({ projectToken, assetId }).catch(() => undefined);
        setError(finalized.error);
        return;
      }

      form.reset();
      setMessage(finalized.message || "We received your document.");
    } catch {
      if (assetId) {
        await abortProjectDocumentUpload({ projectToken, assetId }).catch(() => undefined);
      }
      setError("That document could not be uploaded. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      {documents.length > 0 ? (
        <ul className="space-y-2 text-sm">
          {documents.map((document) => (
            <li key={document.id}>
              <p className="font-medium">{document.originalFilename}</p>
              <p className="text-muted-foreground">
                Received {formatDate(document.createdAt)} ·{" "}
                {formatStorageBytes(document.fileSizeBytes)} · pending owner review
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No documents uploaded yet. Files stay private to this project.
        </p>
      )}

      {remaining > 0 ? (
        <form onSubmit={onSubmit} className="space-y-3">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {message ? (
            <p className="text-sm text-muted-foreground">{message}</p>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="project-document-file">Private document</Label>
            <Input
              id="project-document-file"
              name="file"
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp"
              required
              disabled={pending}
              className="h-12 w-full text-base file:me-3 file:h-8 file:px-3"
            />
            <p className="text-xs text-muted-foreground">
              PDF, JPEG, PNG, or WebP. Up to {projectDocumentMaxBytesLabel()}.
              You can add {remaining} more.
            </p>
          </div>
          <Button type="submit" disabled={pending} className="h-12 w-full text-base">
            {pending ? "Uploading…" : "Upload document"}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          This project already has {PROJECT_DOCUMENT_MAX_COUNT} documents.
        </p>
      )}
    </div>
  );
}

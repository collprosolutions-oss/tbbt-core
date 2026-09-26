"use client";

import { useState, type FormEvent } from "react";
import {
  abortManagementJobPhotoUpload,
  authorizeManagementJobPhotoUpload,
  finalizeManagementJobPhotoUpload,
} from "@/app/actions/job-photo";
import {
  inspectRequestPhotoUpload,
  requestPhotoMaxBytesLabel,
} from "@/lib/business-storage/request-photo-rules";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * OWNER/ADMIN job-photo upload. The image body is PUT straight to private
 * business storage (R2); the server action only authorizes the upload and
 * then persists the JobPhoto metadata. Unlike the field form, this path
 * is business-owned and does not require a job assignment.
 *
 * Capture matches the Field mobile standard: `capture="environment"` opens
 * the phone's rear camera on most mobile browsers, while accept="image/*"
 * still allows choosing an existing gallery photo.
 */
export function AddJobPhotoForm({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        className="h-12 w-full text-base"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Add Photo
      </Button>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    const stage = String(formData.get("stage") || "");
    const caption = String(formData.get("caption") || "");
    const file = formData.get("file");

    if (stage !== "BEFORE" && stage !== "DURING" && stage !== "AFTER") {
      setError("Choose Before, During, or After.");
      return;
    }
    if (!(file instanceof File) || file.size === 0) {
      setError("Choose a photo to upload.");
      return;
    }

    const inspection = inspectRequestPhotoUpload(file);
    if (!inspection.ok) {
      setError(inspection.error);
      return;
    }

    setPending(true);
    setError(null);
    let assetId = "";
    try {
      const authorized = await authorizeManagementJobPhotoUpload({
        jobId,
        originalFilename: inspection.fileName,
        mimeType: inspection.mimeType,
        fileSizeBytes: inspection.fileSizeBytes,
      });
      if (authorized.error || !authorized.assetId || !authorized.uploadUrl) {
        setError(authorized.error || "That photo could not be authorized.");
        return;
      }
      assetId = authorized.assetId;

      const uploaded = await fetch(authorized.uploadUrl, {
        method: authorized.uploadMethod || "PUT",
        headers: authorized.uploadHeaders,
        body: file,
      });
      if (!uploaded.ok) {
        await abortManagementJobPhotoUpload({ jobId, assetId });
        setError("The photo could not be uploaded to file storage. Try again.");
        return;
      }

      const finalized = await finalizeManagementJobPhotoUpload({
        jobId,
        assetId,
        stage,
        caption,
      });
      if (finalized.error) {
        await abortManagementJobPhotoUpload({ jobId, assetId }).catch(() => undefined);
        setError(finalized.error);
        return;
      }

      form.reset();
      setOpen(false);
    } catch {
      if (assetId) {
        await abortManagementJobPhotoUpload({ jobId, assetId }).catch(() => undefined);
      }
      setError("That photo could not be uploaded. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border p-3">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="photo-stage">Stage</Label>
        <select
          id="photo-stage"
          name="stage"
          defaultValue="BEFORE"
          disabled={pending}
          className="h-11 w-full rounded-lg border border-input bg-transparent px-2.5 text-base"
        >
          <option value="BEFORE">Before</option>
          <option value="DURING">During</option>
          <option value="AFTER">After</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="photo-file">Photo</Label>
        <Input
          id="photo-file"
          name="file"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/*"
          capture="environment"
          required
          disabled={pending}
          className="h-12 w-full text-base file:me-3 file:h-8 file:px-3"
        />
        <p className="text-xs text-muted-foreground">
          Take a photo or choose one from your device. Up to {requestPhotoMaxBytesLabel()}. JPEG, PNG, WebP, or HEIC.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="photo-caption">Caption (optional)</Label>
        <Input
          id="photo-caption"
          name="caption"
          disabled={pending}
          className="h-11 text-base"
          placeholder="e.g. Leaky faucet before repair"
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending} className="h-12 flex-1 text-base">
          {pending ? "Uploading…" : "Add photo"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          className="h-12 text-base"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

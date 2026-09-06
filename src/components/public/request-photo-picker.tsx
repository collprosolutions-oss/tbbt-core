"use client";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { inspectRequestPhotoUpload, requestPhotoMaxBytesLabel } from "@/lib/business-storage/request-photo-rules";
import { isBrowserPreviewableRequestPhoto } from "@/lib/intake-quote-handoff";
import { MAX_INTAKE_PHOTOS } from "@/lib/service-request-work";

export type SelectedRequestPhoto = {
  id: string;
  file: File;
  previewUrl: string;
  mimeType: string;
  previewable: boolean;
};

export function RequestPhotoPicker({
  photos,
  onChange,
  businessName,
}: {
  photos: SelectedRequestPhoto[];
  onChange: (photos: SelectedRequestPhoto[]) => void;
  businessName: string;
}) {
  const [localError, setLocalError] = useState<string | null>(null);
  const remaining = MAX_INTAKE_PHOTOS - photos.length;

  const previews = useMemo(() => photos, [photos]);

  useEffect(() => {
    return () => {
      for (const photo of photos) {
        if (photo.previewUrl) URL.revokeObjectURL(photo.previewUrl);
      }
    };
    // Revoke only on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addFiles(fileList: FileList | null) {
    const incoming = Array.from(fileList ?? []);
    if (incoming.length === 0) return;
    const next = [...photos];
    let error: string | null = null;
    for (const file of incoming) {
      if (next.length >= MAX_INTAKE_PHOTOS) {
        error = `You can add up to ${MAX_INTAKE_PHOTOS} photos.`;
        break;
      }
      const inspection = inspectRequestPhotoUpload(file);
      if (!inspection.ok) {
        error = inspection.error;
        continue;
      }
      const previewable = isBrowserPreviewableRequestPhoto(inspection.mimeType);
      next.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${next.length}`,
        file,
        previewUrl: previewable ? URL.createObjectURL(file) : "",
        mimeType: inspection.mimeType,
        previewable,
      });
    }
    setLocalError(error);
    onChange(next);
  }

  function removePhoto(id: string) {
    const match = photos.find((photo) => photo.id === id);
    if (match?.previewUrl) URL.revokeObjectURL(match.previewUrl);
    onChange(photos.filter((photo) => photo.id !== id));
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="photos">Project photos (optional)</Label>
      <p className="text-sm text-muted-foreground">
        Photos help {businessName} understand the work. You can add up to{" "}
        {MAX_INTAKE_PHOTOS} JPEG, PNG, WebP, or HEIC images, up to{" "}
        {requestPhotoMaxBytesLabel()} each. These stay private and are not
        published on the website.
      </p>
      <Input
        id="photos"
        name="photos"
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,image/*"
        multiple
        disabled={remaining <= 0}
        className="h-12 bg-white pt-2"
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      {localError ? <p className="text-sm text-red-700">{localError}</p> : null}
      {previews.length > 0 ? (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {previews.map((photo) => (
            <li key={photo.id} className="relative overflow-hidden rounded-md border border-border bg-white">
              {photo.previewable && photo.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={photo.previewUrl}
                  alt=""
                  className="aspect-square w-full object-cover"
                />
              ) : (
                <div className="flex aspect-square w-full flex-col items-center justify-center gap-1 bg-muted/40 p-2 text-center">
                  <p className="line-clamp-3 text-[11px] font-medium">{photo.file.name}</p>
                  <p className="text-[10px] text-muted-foreground">Saved with your request. Preview is not available for this phone photo format.</p>
                </div>
              )}
              <button
                type="button"
                className="absolute right-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-extrabold tracking-wide text-white uppercase"
                onClick={() => removePhoto(photo.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

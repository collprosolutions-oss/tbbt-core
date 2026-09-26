"use client";

import { useActionState, useState } from "react";
import { deleteJobPhoto, type JobPhotoActionState } from "@/app/actions/job-photo";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";

const initialState: JobPhotoActionState = {};

export const REMOVE_JOB_PHOTO_CONFIRM =
  "Remove this photo? This cannot be undone.";

export type JobPhotoDetails = {
  id: string;
  url: string;
  caption: string | null;
  createdAt: Date;
};

export function JobPhotoItem({ photo }: { photo: JobPhotoDetails }) {
  const [state, formAction, pending] = useActionState(
    deleteJobPhoto,
    initialState,
  );
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="w-36 space-y-1 text-xs">
      <a
        href={photo.url}
        target="_blank"
        rel="noreferrer noopener"
        className="block"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photo.url}
          alt={photo.caption ?? "Job photo"}
          loading="lazy"
          className="h-36 w-36 rounded-lg border object-cover"
        />
      </a>
      {photo.caption ? (
        <p className="break-words text-muted-foreground">{photo.caption}</p>
      ) : null}
      <p className="text-muted-foreground">{formatDate(photo.createdAt)}</p>
      {confirming ? (
        <form action={formAction} className="space-y-2">
          <input type="hidden" name="photoId" value={photo.id} />
          <p className="text-xs font-medium text-destructive">
            {REMOVE_JOB_PHOTO_CONFIRM}
          </p>
          <div className="flex flex-col gap-1.5">
            <Button
              type="submit"
              size="sm"
              variant="destructive"
              disabled={pending}
              className="h-10 w-full text-sm"
            >
              {pending ? "Removing…" : "Remove photo"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              className="h-10 w-full text-sm"
              onClick={() => setConfirming(false)}
            >
              Keep photo
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          className="h-10 w-full text-sm"
          onClick={() => setConfirming(true)}
        >
          Remove
        </Button>
      )}
      {state.error ? (
        <p className="break-words text-destructive">{state.error}</p>
      ) : null}
    </li>
  );
}

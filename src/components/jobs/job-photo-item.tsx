"use client";

import { useActionState } from "react";
import { deleteJobPhoto, type JobPhotoActionState } from "@/app/actions/job-photo";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";

const initialState: JobPhotoActionState = {};

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
      <form action={formAction}>
        <input type="hidden" name="photoId" value={photo.id} />
        <Button type="submit" size="xs" variant="outline" disabled={pending}>
          {pending ? "Removing…" : "Remove"}
        </Button>
      </form>
      {state.error ? (
        <p className="break-words text-destructive">{state.error}</p>
      ) : null}
    </li>
  );
}

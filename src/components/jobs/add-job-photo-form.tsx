"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { addJobPhoto, type JobPhotoActionState } from "@/app/actions/job-photo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: JobPhotoActionState = {};

export function AddJobPhotoForm({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(addJobPhoto, initialState);
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !pending && !state.error) {
      setOpen(false);
    }
    wasPending.current = pending;
  }, [pending, state]);

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        Add Photo
      </Button>
    );
  }

  return (
    <form action={formAction} className="space-y-3 rounded-lg border p-3">
      <input type="hidden" name="jobId" value={jobId} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="photo-stage">Stage</Label>
        <select
          id="photo-stage"
          name="stage"
          defaultValue="BEFORE"
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          <option value="BEFORE">Before</option>
          <option value="DURING">During</option>
          <option value="AFTER">After</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="photo-url">Photo URL</Label>
        <Input
          id="photo-url"
          name="url"
          type="url"
          inputMode="url"
          placeholder="https://..."
          required
        />
        <p className="text-xs text-muted-foreground">
          Paste a link to an already-hosted photo. Direct upload from your
          phone isn&apos;t connected yet.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="photo-caption">Caption (optional)</Label>
        <Input
          id="photo-caption"
          name="caption"
          placeholder="e.g. Leaky faucet before repair"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Adding…" : "Add photo"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

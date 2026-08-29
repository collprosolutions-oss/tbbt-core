"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  addAssignedJobPhoto,
  type FieldJobActionState,
} from "@/app/actions/field-job";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: FieldJobActionState = {};

/**
 * Mobile-first photo upload for the assigned MEMBER, reusing the exact same
 * private Job Photo storage as the internal Work Order (see
 * addAssignedJobPhoto in src/app/actions/field-job.ts /
 * src/lib/storage.ts). `capture="environment"` opens the phone's rear
 * camera directly when a file input is tapped on most mobile browsers,
 * while still allowing choosing an existing photo.
 */
export function AddFieldJobPhotoForm({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    addAssignedJobPhoto,
    initialState,
  );
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
        variant="outline"
        className="h-12 w-full text-base"
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
        <Label htmlFor="field-photo-stage">Stage</Label>
        <select
          id="field-photo-stage"
          name="stage"
          defaultValue="BEFORE"
          className="h-11 w-full rounded-lg border border-input bg-transparent px-2.5 text-base"
        >
          <option value="BEFORE">Before</option>
          <option value="DURING">During</option>
          <option value="AFTER">After</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="field-photo-file">Photo</Label>
        <Input
          id="field-photo-file"
          name="file"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/*"
          capture="environment"
          required
          className="h-11 text-base"
        />
        <p className="text-xs text-muted-foreground">
          Take a photo or choose one from your device. Up to 4 MB.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="field-photo-caption">Caption (optional)</Label>
        <Input
          id="field-photo-caption"
          name="caption"
          className="h-11 text-base"
          placeholder="e.g. Leaky faucet before repair"
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending} className="h-12 flex-1 text-base">
          {pending ? "Adding…" : "Add photo"}
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

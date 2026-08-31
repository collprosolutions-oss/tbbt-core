"use client";

import { useActionState, useMemo, useState } from "react";
import { createMarketingContentAction, type MarketingActionState } from "@/app/actions/marketing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MARKETING_CHANNEL_LABELS,
  MARKETING_CHANNELS,
  MARKETING_CONTENT_TYPE_LABELS,
  MARKETING_CONTENT_TYPES,
} from "@/lib/marketing";
import type { MarketingSource } from "@/lib/marketing-data";

const initial: MarketingActionState = {};

export function CreateContentForm({ source }: { source: MarketingSource }) {
  const [jobId, setJobId] = useState("");
  const [state, formAction, pending] = useActionState(createMarketingContentAction, initial);

  const approvedPhotos = useMemo(() => {
    const pool = jobId
      ? source.opportunities.filter((row) => row.jobId === jobId)
      : source.opportunities;
    return pool.flatMap((row) =>
      row.photos
        .filter((photo) => photo.marketingPermissionStatus === "APPROVED")
        .map((photo) => ({
          ...photo,
          jobId: row.jobId,
          workPerformed: row.workPerformed,
        })),
    );
  }, [jobId, source.opportunities]);

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="contentType">Content type</Label>
          <select
            id="contentType"
            name="contentType"
            required
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            defaultValue="COMPLETED_JOB"
          >
            {MARKETING_CONTENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {MARKETING_CONTENT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="channelIntent">Channel intent</Label>
          <select
            id="channelIntent"
            name="channelIntent"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            defaultValue="UNASSIGNED"
          >
            {MARKETING_CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {MARKETING_CHANNEL_LABELS[channel]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="title">Internal title</Label>
        <Input id="title" name="title" required placeholder="Before & after — faucet repair" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="body">Caption / body</Label>
        <textarea
          id="body"
          name="body"
          rows={4}
          placeholder="Write the post yourself. Do not include customer names, phones, addresses, or private notes."
          className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="jobId">Source job (optional)</Label>
          <select
            id="jobId"
            name="jobId"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={jobId}
            onChange={(event) => setJobId(event.target.value)}
          >
            <option value="">No source job</option>
            {source.opportunities.map((row) => (
              <option key={row.jobId} value={row.jobId}>
                {row.workPerformed} · {row.customerName}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="plannedFor">Internal planning date (optional)</Label>
          <Input id="plannedFor" name="plannedFor" type="date" />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Marketing-approved photos</legend>
        <p className="text-xs text-muted-foreground">
          Private job photos are not listed. Approve a photo on Completed Jobs before it can be selected.
        </p>
        {approvedPhotos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No marketing-approved photos available for this selection.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {approvedPhotos.map((photo) => (
              <li key={photo.id} className="rounded-lg border border-border/70 p-2">
                <label className="flex cursor-pointer flex-col gap-1 text-xs">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photo.url} alt="" className="h-24 w-full rounded-md object-cover" />
                  <span className="flex items-center gap-2">
                    <input type="checkbox" name="photoIds" value={photo.id} />
                    {photo.stage}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <Button type="submit" disabled={pending}>
        {pending ? "Saving draft…" : "Save content draft"}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

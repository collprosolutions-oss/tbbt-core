"use client";

import { useActionState, useMemo, useState } from "react";
import { createMarketingContentAction, type MarketingActionState } from "@/app/actions/marketing";
import { StudioPackagePreview } from "@/components/marketing/studio-package-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { draftMarketingStudioPackage } from "@/lib/marketing-draft";
import {
  CREATOR_PACKAGE_LIMITS_MESSAGE,
  FLOW_VEO_DISCONNECTED_MESSAGE,
  PAID_ADS_DISCONNECTED_MESSAGE,
  serializeShotList,
  serializeStoryboard,
  type ShotListItem,
  type StoryboardBeat,
} from "@/lib/marketing";
import type { MarketingSource } from "@/lib/marketing-data";

const initial: MarketingActionState = {};

export function CreateContentForm({ source }: { source: MarketingSource }) {
  const readyJobs = source.opportunities.filter((row) => row.readiness === "ready");
  const [jobId, setJobId] = useState(readyJobs[0]?.jobId ?? "");
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [storyboard, setStoryboard] = useState<StoryboardBeat[]>([]);
  const [shotList, setShotList] = useState<ShotListItem[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [state, formAction, pending] = useActionState(createMarketingContentAction, initial);

  const selectedJob = source.opportunities.find((row) => row.jobId === jobId) ?? null;
  const approvedPhotos = useMemo(
    () =>
      (selectedJob?.photos ?? []).filter((photo) => photo.marketingPermissionStatus === "APPROVED"),
    [selectedJob],
  );
  const selectedPhotos = approvedPhotos.filter((photo) => photoIds.includes(photo.id));

  function applyDraftFromFacts(nextJobId = jobId, nextPhotoIds = photoIds) {
    const job = source.opportunities.find((row) => row.jobId === nextJobId);
    const photos = (job?.photos ?? []).filter(
      (photo) => nextPhotoIds.includes(photo.id) && photo.marketingPermissionStatus === "APPROVED",
    );
    const first = photos[0];
    const draft = draftMarketingStudioPackage(
      {
        contentType: "COMPLETED_JOB",
        businessName: source.brand.name,
        brandVoice: source.brand.voice,
        identityNotes: source.brand.identityNotes,
        workPerformed: job?.workPerformed,
        city: source.recordedActivity.city,
        photoCount: photos.length,
        photoStage: first?.stage,
        photoCaption: first?.caption,
      },
      photos.map((photo) => photo.id),
    );
    setTitle(draft.title);
    setBody(draft.caption);
    setHashtags(draft.hashtags.join(" "));
    setStoryboard(draft.storyboard);
    setShotList(draft.shotList);
    setShowPreview(true);
  }

  function togglePhoto(photoId: string) {
    const next = photoIds.includes(photoId)
      ? photoIds.filter((id) => id !== photoId)
      : [...photoIds, photoId];
    setPhotoIds(next);
    if (next.length > 0) applyDraftFromFacts(jobId, next);
    else {
      setStoryboard([]);
      setShotList([]);
    }
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="contentType" value="COMPLETED_JOB" />
      <input type="hidden" name="channelIntent" value="UNASSIGNED" />
      <input type="hidden" name="storyboardJson" value={serializeStoryboard(storyboard)} />
      <input type="hidden" name="shotListJson" value={serializeShotList(shotList)} />

      <p className="text-sm text-muted-foreground">{CREATOR_PACKAGE_LIMITS_MESSAGE}</p>
      <p className="text-xs text-muted-foreground">{FLOW_VEO_DISCONNECTED_MESSAGE}</p>
      <p className="text-xs text-muted-foreground">{PAID_ADS_DISCONNECTED_MESSAGE}</p>

      <div className="space-y-1.5">
        <Label htmlFor="jobId">Completed job</Label>
        <select
          id="jobId"
          name="jobId"
          required
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={jobId}
          onChange={(event) => {
            setJobId(event.target.value);
            setPhotoIds([]);
            setStoryboard([]);
            setShotList([]);
            setShowPreview(false);
          }}
        >
          <option value="">Select a completed job</option>
          {readyJobs.map((row) => (
            <option key={row.jobId} value={row.jobId}>
              {row.workPerformed} · {row.approvedPhotoCount} approved photo
              {row.approvedPhotoCount === 1 ? "" : "s"}
            </option>
          ))}
        </select>
        {readyJobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Approve a job photo on Completed Jobs before a creator package can start.
          </p>
        ) : null}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Marketing-approved photo</legend>
        <p className="text-xs text-muted-foreground">
          Private photos are not listed. Revoking permission later blocks approval and export.
        </p>
        {approvedPhotos.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No marketing-approved photos are on this job.
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {approvedPhotos.map((photo) => (
              <li key={photo.id} className="rounded-lg border border-border/70 p-2">
                <label className="flex cursor-pointer flex-col gap-1 text-xs">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photo.url} alt="" className="h-24 w-full rounded-md object-cover" />
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name="photoIds"
                      value={photo.id}
                      checked={photoIds.includes(photo.id)}
                      onChange={() => togglePhoto(photo.id)}
                    />
                    {photo.stage}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="title">Internal title</Label>
        <Input
          id="title"
          name="title"
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Completed faucet repair"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="body">Caption from recorded facts</Label>
        <textarea
          id="body"
          name="body"
          rows={4}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Edit the draft. Do not add customer names, phones, or addresses."
          className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="hashtags">Hashtags</Label>
        <Input
          id="hashtags"
          name="hashtags"
          value={hashtags}
          onChange={(event) => setHashtags(event.target.value)}
          placeholder="#LocalHandyman #HomeRepair"
        />
      </div>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Storyboard</h3>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => applyDraftFromFacts()}
            disabled={photoIds.length === 0}
          >
            Draft from recorded facts
          </Button>
        </div>
        {storyboard.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Select an approved photo to draft beats from the job record.
          </p>
        ) : (
          <ul className="space-y-2">
            {storyboard.map((beat, index) => (
              <li key={`${beat.heading}-${index}`} className="grid gap-2 rounded-md border p-2 sm:grid-cols-3">
                <Input
                  aria-label={`Storyboard ${index + 1} heading`}
                  value={beat.heading}
                  onChange={(event) => {
                    const next = [...storyboard];
                    next[index] = { ...beat, heading: event.target.value };
                    setStoryboard(next);
                  }}
                />
                <Input
                  aria-label={`Storyboard ${index + 1} visual`}
                  value={beat.visual}
                  onChange={(event) => {
                    const next = [...storyboard];
                    next[index] = { ...beat, visual: event.target.value };
                    setStoryboard(next);
                  }}
                />
                <Input
                  aria-label={`Storyboard ${index + 1} narration`}
                  value={beat.narration}
                  onChange={(event) => {
                    const next = [...storyboard];
                    next[index] = { ...beat, narration: event.target.value };
                    setStoryboard(next);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Shot list</h3>
        {shotList.length === 0 ? (
          <p className="text-sm text-muted-foreground">No shots drafted yet.</p>
        ) : (
          <ul className="space-y-2">
            {shotList.map((shot, index) => (
              <li key={`${shot.order}-${index}`} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[4rem_1fr_1fr]">
                <Input
                  aria-label={`Shot ${index + 1} order`}
                  type="number"
                  min={1}
                  value={shot.order}
                  onChange={(event) => {
                    const next = [...shotList];
                    next[index] = { ...shot, order: Number(event.target.value) || index + 1 };
                    setShotList(next);
                  }}
                />
                <Input
                  aria-label={`Shot ${index + 1} name`}
                  value={shot.shot}
                  onChange={(event) => {
                    const next = [...shotList];
                    next[index] = { ...shot, shot: event.target.value };
                    setShotList(next);
                  }}
                />
                <Input
                  aria-label={`Shot ${index + 1} purpose`}
                  value={shot.purpose}
                  onChange={(event) => {
                    const next = [...shotList];
                    next[index] = { ...shot, purpose: event.target.value };
                    setShotList(next);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setShowPreview((value) => !value)}
          disabled={photoIds.length === 0}
        >
          {showPreview ? "Hide preview" : "Preview package"}
        </Button>
        <Button type="submit" disabled={pending || photoIds.length === 0}>
          {pending ? "Saving draft…" : "Save creator package draft"}
        </Button>
      </div>

      {showPreview ? (
        <StudioPackagePreview
          title={title}
          caption={body}
          hashtags={hashtags}
          storyboard={storyboard}
          shotList={shotList}
          photos={selectedPhotos}
          businessName={source.brand.name}
          workPerformed={selectedJob?.workPerformed ?? null}
          city={source.recordedActivity.city ?? null}
        />
      ) : null}

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

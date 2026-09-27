"use client";

import { useActionState, useState } from "react";
import { updateMarketingStudioAction, type MarketingActionState } from "@/app/actions/marketing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  parseShotList,
  parseStoryboard,
  serializeShotList,
  serializeStoryboard,
  type ShotListItem,
  type StoryboardBeat,
} from "@/lib/marketing";

const initial: MarketingActionState = {};

export function StudioEditForm({
  contentId,
  title,
  body,
  hashtags,
  storyboardJson,
  shotListJson,
}: {
  contentId: string;
  title: string;
  body: string;
  hashtags: string;
  storyboardJson: string;
  shotListJson: string;
}) {
  const [nextTitle, setNextTitle] = useState(title);
  const [caption, setCaption] = useState(body);
  const [tags, setTags] = useState(hashtags);
  const [storyboard, setStoryboard] = useState<StoryboardBeat[]>(parseStoryboard(storyboardJson));
  const [shotList, setShotList] = useState<ShotListItem[]>(parseShotList(shotListJson));
  const [state, formAction, pending] = useActionState(updateMarketingStudioAction, initial);

  return (
    <form action={formAction} className="space-y-2 rounded-md border p-2">
      <input type="hidden" name="contentId" value={contentId} />
      <input type="hidden" name="storyboardJson" value={serializeStoryboard(storyboard)} />
      <input type="hidden" name="shotListJson" value={serializeShotList(shotList)} />
      <Label htmlFor={`edit-title-${contentId}`}>Edit draft</Label>
      <Input
        id={`edit-title-${contentId}`}
        name="title"
        value={nextTitle}
        onChange={(event) => setNextTitle(event.target.value)}
      />
      <textarea
        name="body"
        rows={3}
        value={caption}
        onChange={(event) => setCaption(event.target.value)}
        className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      <Input name="hashtags" value={tags} onChange={(event) => setTags(event.target.value)} />
      {storyboard.map((beat, index) => (
        <div key={`${beat.heading}-${index}`} className="grid gap-1 sm:grid-cols-3">
          <Input
            aria-label={`Edit beat ${index + 1} heading`}
            value={beat.heading}
            onChange={(event) => {
              const next = [...storyboard];
              next[index] = { ...beat, heading: event.target.value };
              setStoryboard(next);
            }}
          />
          <Input
            aria-label={`Edit beat ${index + 1} visual`}
            value={beat.visual}
            onChange={(event) => {
              const next = [...storyboard];
              next[index] = { ...beat, visual: event.target.value };
              setStoryboard(next);
            }}
          />
          <Input
            aria-label={`Edit beat ${index + 1} narration`}
            value={beat.narration}
            onChange={(event) => {
              const next = [...storyboard];
              next[index] = { ...beat, narration: event.target.value };
              setStoryboard(next);
            }}
          />
        </div>
      ))}
      {shotList.map((shot, index) => (
        <div key={`${shot.order}-${index}`} className="grid gap-1 sm:grid-cols-2">
          <Input
            aria-label={`Edit shot ${index + 1} name`}
            value={shot.shot}
            onChange={(event) => {
              const next = [...shotList];
              next[index] = { ...shot, shot: event.target.value };
              setShotList(next);
            }}
          />
          <Input
            aria-label={`Edit shot ${index + 1} purpose`}
            value={shot.purpose}
            onChange={(event) => {
              const next = [...shotList];
              next[index] = { ...shot, purpose: event.target.value };
              setShotList(next);
            }}
          />
        </div>
      ))}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Save storyboard edits"}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}

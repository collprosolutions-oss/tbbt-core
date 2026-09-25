"use client";

import { useActionState, useState } from "react";
import {
  updateWebsiteStorySettings,
  type SettingsActionState,
} from "@/app/actions/settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { WritingAssistBar } from "@/components/ai/writing-assist-bar";
import {
  MAX_OWNER_STORY_LENGTH,
  MAX_PUBLIC_ABOUT_COPY_LENGTH,
  WEBSITE_STORY_AI_UNAVAILABLE,
} from "@/lib/website-story";

const initialState: SettingsActionState = {};

export function WebsiteStoryForm({
  businessId,
  rawOwnerStory,
  approvedPublicAboutCopy,
  canEdit,
}: {
  businessId: string;
  rawOwnerStory: string;
  approvedPublicAboutCopy: string;
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(
    updateWebsiteStorySettings,
    initialState,
  );
  const [ownerStory, setOwnerStory] = useState(rawOwnerStory);
  const [aboutCopy, setAboutCopy] = useState(approvedPublicAboutCopy);

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="businessId" value={businessId} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <Alert>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Raw owner story is background only. Approved public About copy is what
        customers see. The two fields are never mixed automatically.
      </p>
      <div className="space-y-2">
        <label htmlFor="rawOwnerStory" className="text-sm font-medium">
          Raw owner story
        </label>
        <textarea
          id="rawOwnerStory"
          name="rawOwnerStory"
          rows={7}
          maxLength={MAX_OWNER_STORY_LENGTH}
          value={ownerStory}
          onChange={(event) => setOwnerStory(event.target.value)}
          disabled={!canEdit || pending}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="Type background, experience, and facts in your own words."
        />
        {canEdit ? (
          <WritingAssistBar
            original={ownerStory}
            context="Owner background story. Rephrase only facts written here. Never invent credentials."
            onSuggestion={setOwnerStory}
          />
        ) : null}
        <p className="text-xs text-muted-foreground">
          Not published. Suggestions stay private until you copy them into approved About copy and save.
        </p>
      </div>
      <div className="space-y-2">
        <label htmlFor="approvedPublicAboutCopy" className="text-sm font-medium">
          Approved public About copy
        </label>
        <textarea
          id="approvedPublicAboutCopy"
          name="approvedPublicAboutCopy"
          rows={8}
          maxLength={MAX_PUBLIC_ABOUT_COPY_LENGTH}
          value={aboutCopy}
          onChange={(event) => setAboutCopy(event.target.value)}
          disabled={!canEdit || pending}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="The concise About story customers will read. Leave blank to use the default public copy."
        />
        {canEdit ? (
          <WritingAssistBar
            original={aboutCopy}
            context="Public About copy. Rephrase only owner-supplied facts. Never invent years, licenses, awards, or insurance."
            onSuggestion={setAboutCopy}
          />
        ) : null}
        <p className="text-xs text-muted-foreground">
          Owner/admin approval is required before this text appears on the website.
        </p>
      </div>
      <p className="text-sm text-muted-foreground">{WEBSITE_STORY_AI_UNAVAILABLE}</p>
      <Button type="submit" disabled={!canEdit || pending}>
        {pending ? "Saving…" : "Save Website Story"}
      </Button>
    </form>
  );
}

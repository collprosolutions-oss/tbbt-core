"use client";

import { useActionState } from "react";
import {
  updateWebsiteStorySettings,
  type SettingsActionState,
} from "@/app/actions/settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
          defaultValue={rawOwnerStory}
          disabled={!canEdit || pending}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="Type background, experience, and facts in your own words."
        />
        <p className="text-xs text-muted-foreground">
          Not published. Future copy assistance may only rephrase facts written here.
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
          defaultValue={approvedPublicAboutCopy}
          disabled={!canEdit || pending}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="The concise About story customers will read. Leave blank to use the default public copy."
        />
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

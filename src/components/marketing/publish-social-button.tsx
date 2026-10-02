"use client";

import { useActionState } from "react";
import {
  publishMarketingContentToSocialAction,
  type MarketingSocialPublishState,
} from "@/app/actions/marketing";
import { Button } from "@/components/ui/button";
import {
  OWNER_SOCIAL_PUBLISH_MESSAGE,
  SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
  SOCIAL_PUBLISH_ATTEMPT_FAILED,
  SOCIAL_PUBLISH_ATTEMPT_PUBLISHED,
  SOCIAL_PUBLISH_DESTINATION_DISCONNECTED_MESSAGE,
  SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
  SOCIAL_PUBLISH_FAILED_MESSAGE,
  SOCIAL_PUBLISH_IN_FLIGHT_MESSAGE,
  SOCIAL_PUBLISH_PUBLISHED_MESSAGE,
} from "@/lib/marketing";

const initial: MarketingSocialPublishState = {};

export function PublishSocialButton({
  contentId,
  expectedUpdatedAt,
  canPublish,
  destinationConnected,
  attemptStatus,
  attemptLabel,
}: {
  contentId: string;
  expectedUpdatedAt: string;
  canPublish: boolean;
  destinationConnected: boolean;
  attemptStatus: string | null;
  attemptLabel: string | null;
}) {
  const [state, formAction, pending] = useActionState(publishMarketingContentToSocialAction, initial);
  const published = state.published === true || attemptStatus === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED;
  const failed =
    !published &&
    (state.status === SOCIAL_PUBLISH_ATTEMPT_FAILED || attemptStatus === SOCIAL_PUBLISH_ATTEMPT_FAILED);
  const inFlight =
    !published &&
    (state.status === SOCIAL_PUBLISH_ATTEMPT_CLAIMED || attemptStatus === SOCIAL_PUBLISH_ATTEMPT_CLAIMED);
  const failureText = published
    ? null
    : state.error || (failed ? state.message || attemptLabel || SOCIAL_PUBLISH_FAILED_MESSAGE : null);

  if (published) {
    return <p className="text-xs text-muted-foreground">{SOCIAL_PUBLISH_PUBLISHED_MESSAGE}</p>;
  }
  if (!destinationConnected) {
    return <p className="text-xs text-muted-foreground">{SOCIAL_PUBLISH_DESTINATION_DISCONNECTED_MESSAGE}</p>;
  }
  if (inFlight) {
    return <p className="text-xs text-muted-foreground">{SOCIAL_PUBLISH_IN_FLIGHT_MESSAGE}</p>;
  }
  if (!canPublish) {
    return <p className="text-xs text-muted-foreground">{OWNER_SOCIAL_PUBLISH_MESSAGE}</p>;
  }

  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="contentId" value={contentId} />
      <input type="hidden" name="destination" value={SOCIAL_PUBLISH_DESTINATION_FACEBOOK} />
      <input type="hidden" name="expectedUpdatedAt" value={expectedUpdatedAt} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Publishing…" : failed ? "Retry Facebook publish" : "Publish to Facebook"}
      </Button>
      {failureText ? <p className="text-xs text-destructive">{failureText}</p> : null}
    </form>
  );
}

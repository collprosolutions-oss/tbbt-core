"use client";

import { useActionState } from "react";
import {
  publishMarketingContentToSocialAction,
  resolveMarketingSocialPublishAttemptAction,
  type MarketingSocialPublishState,
} from "@/app/actions/marketing";
import { Button } from "@/components/ui/button";
import {
  OWNER_SOCIAL_PUBLISH_MESSAGE,
  SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
  SOCIAL_PUBLISH_ATTEMPT_FAILED,
  SOCIAL_PUBLISH_ATTEMPT_PUBLISHED,
  SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
  SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
  SOCIAL_PUBLISH_RESOLVE_NOT_POSTED,
  SOCIAL_PUBLISH_RESOLVE_POSTED,
  socialPublishCopy,
} from "@/lib/marketing";

const initial: MarketingSocialPublishState = {};

export function PublishSocialButton({
  contentId,
  expectedUpdatedAt,
  destination = SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
  canPublish,
  destinationConnected,
  attemptId,
  attemptStatus,
  attemptLabel,
  unconfirmed,
  canResolve,
  blockedMessage,
}: {
  contentId: string;
  expectedUpdatedAt: string;
  destination?: typeof SOCIAL_PUBLISH_DESTINATION_FACEBOOK | typeof SOCIAL_PUBLISH_DESTINATION_INSTAGRAM;
  canPublish: boolean;
  destinationConnected: boolean;
  attemptId: string | null;
  attemptStatus: string | null;
  attemptLabel: string | null;
  unconfirmed: boolean;
  canResolve: boolean;
  blockedMessage?: string;
}) {
  const copy = socialPublishCopy(destination);
  const [state, formAction, pending] = useActionState(publishMarketingContentToSocialAction, initial);
  const [resolveState, resolveAction, resolvePending] = useActionState(
    resolveMarketingSocialPublishAttemptAction,
    initial,
  );
  const published =
    state.published === true ||
    resolveState.published === true ||
    attemptStatus === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED;
  const failed =
    !published &&
    (state.status === SOCIAL_PUBLISH_ATTEMPT_FAILED || attemptStatus === SOCIAL_PUBLISH_ATTEMPT_FAILED);
  const isUnconfirmed =
    !published &&
    (unconfirmed ||
      state.unconfirmed === true ||
      resolveState.unconfirmed === true ||
      ((state.status === SOCIAL_PUBLISH_ATTEMPT_CLAIMED || attemptStatus === SOCIAL_PUBLISH_ATTEMPT_CLAIMED) &&
        unconfirmed));
  const inFlight =
    !published &&
    !isUnconfirmed &&
    (state.status === SOCIAL_PUBLISH_ATTEMPT_CLAIMED || attemptStatus === SOCIAL_PUBLISH_ATTEMPT_CLAIMED);
  const failureText = published
    ? null
    : state.error || (failed ? state.message || attemptLabel || copy.failed : null);

  if (published) {
    return <p className="text-xs text-muted-foreground">{copy.published}</p>;
  }
  if (!destinationConnected) {
    return <p className="text-xs text-muted-foreground">{copy.disconnected}</p>;
  }
  if (isUnconfirmed) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{copy.unconfirmed}</p>
        {canResolve && attemptId ? (
          <div className="flex flex-wrap gap-2">
            <form action={resolveAction}>
              <input type="hidden" name="attemptId" value={attemptId} />
              <input type="hidden" name="resolution" value={SOCIAL_PUBLISH_RESOLVE_NOT_POSTED} />
              <Button type="submit" size="sm" variant="outline" disabled={resolvePending}>
                Not posted, allow retry
              </Button>
            </form>
            <form action={resolveAction}>
              <input type="hidden" name="attemptId" value={attemptId} />
              <input type="hidden" name="resolution" value={SOCIAL_PUBLISH_RESOLVE_POSTED} />
              <Button type="submit" size="sm" disabled={resolvePending}>
                It posted
              </Button>
            </form>
          </div>
        ) : null}
        {resolveState.error ? <p className="text-xs text-destructive">{resolveState.error}</p> : null}
      </div>
    );
  }
  if (inFlight) {
    return <p className="text-xs text-muted-foreground">{copy.inFlight}</p>;
  }
  if (!canPublish) {
    return (
      <p className="text-xs text-muted-foreground">
        {blockedMessage || copy.owner || OWNER_SOCIAL_PUBLISH_MESSAGE}
      </p>
    );
  }

  const retryLabel = destination === SOCIAL_PUBLISH_DESTINATION_INSTAGRAM
    ? "Retry Instagram publish"
    : "Retry Facebook publish";
  const publishLabel = destination === SOCIAL_PUBLISH_DESTINATION_INSTAGRAM
    ? "Publish to Instagram"
    : "Publish to Facebook";

  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="contentId" value={contentId} />
      <input type="hidden" name="destination" value={destination} />
      <input type="hidden" name="expectedUpdatedAt" value={expectedUpdatedAt} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Publishing…" : failed ? retryLabel : publishLabel}
      </Button>
      {failureText ? <p className="text-xs text-destructive">{failureText}</p> : null}
    </form>
  );
}

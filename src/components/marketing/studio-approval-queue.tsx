import { StudioApprovalActions } from "@/components/marketing/studio-approval-actions";
import { StudioWeeklyReminderControls } from "@/components/marketing/studio-weekly-reminder";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import {
  MARKETING_CHANNEL_LABELS,
  MARKETING_CONTENT_TYPE_LABELS,
  STUDIO_APPROVAL_QUEUE_LIMITS_MESSAGE,
  WEEKLY_STUDIO_APPROVAL_QUEUE_MESSAGE,
  canActOnStudioApprovalQueue,
  canReturnStudioPackage,
  type MarketingChannel,
  type MarketingContentType,
} from "@/lib/marketing";
import type { MarketingSource } from "@/lib/marketing-data";

export function StudioApprovalQueue({
  queue,
  weeklyReminder,
  viewerRole,
}: {
  queue: MarketingSource["approvalQueue"];
  weeklyReminder: MarketingSource["weeklyReminder"];
  viewerRole: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Weekly approval queue</CardTitle>
        <CardDescription>
          {WEEKLY_STUDIO_APPROVAL_QUEUE_MESSAGE} {STUDIO_APPROVAL_QUEUE_LIMITS_MESSAGE}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <StudioWeeklyReminderControls reminder={weeklyReminder} viewerRole={viewerRole} />
        {queue.items.length === 0 ? (
          <EmptyState
            title="No packages awaiting review"
            description="Creator packages appear here after they are sent for OWNER review. Nothing is auto-approved."
          />
        ) : (
          queue.items.map((row) => {
            const photosEligible = row.photos.length > 0 && row.photos.every((photo) => photo.approved);
            return (
              <div key={row.id} className="space-y-3 rounded-lg border border-border/70 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{row.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {MARKETING_CONTENT_TYPE_LABELS[row.contentType as MarketingContentType] ??
                        row.contentType}
                      {" · "}
                      {MARKETING_CHANNEL_LABELS[row.channelIntent as MarketingChannel] ??
                        row.channelIntent}
                      {" · "}
                      updated {formatDate(row.updatedAt)}
                    </p>
                  </div>
                  <StatusBadge status={row.status} />
                </div>
                {row.body ? <p className="whitespace-pre-wrap text-sm">{row.body}</p> : null}
                {row.hashtags ? <p className="text-xs text-muted-foreground">{row.hashtags}</p> : null}
                {row.photos.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {row.photos.map((photo) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={photo.id}
                        src={photo.url}
                        alt=""
                        className="h-16 w-16 rounded-md object-cover"
                      />
                    ))}
                  </div>
                ) : null}
                <StudioApprovalActions
                  contentId={row.id}
                  canApprove={canActOnStudioApprovalQueue(viewerRole)}
                  canReturn={canReturnStudioPackage({
                    status: row.status,
                    role: viewerRole,
                  })}
                  photosEligible={photosEligible}
                />
              </div>
            );
          })
        )}
        {queue.truncated ? (
          <p className="text-xs text-muted-foreground">
            Showing {queue.limit} of {queue.total} packages awaiting review.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {queue.total} package{queue.total === 1 ? "" : "s"} awaiting review. Limit {queue.limit}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import type { CommunicationTimelineItem } from "@/lib/communications/timeline";

function directionLabel(direction: CommunicationTimelineItem["direction"]) {
  if (direction === "INBOUND") return "Incoming";
  if (direction === "OUTBOUND") return "Outgoing";
  return "Direction not recorded";
}

export function CommunicationTimelineList({
  items,
  timeZone,
}: {
  items: CommunicationTimelineItem[];
  timeZone: string;
}) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No recorded communications yet.
      </p>
    );
  }

  return (
    <ol className="space-y-3">
      {items.map((item) => (
        <li key={item.id} className="rounded-md border border-border/70 p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={item.status} />
            <span className="font-medium">{item.purpose.replaceAll("_", " ")}</span>
            <span className="text-muted-foreground">{item.channel}</span>
            <span className="text-muted-foreground">{directionLabel(item.direction)}</span>
            <span className="text-muted-foreground">{item.contextLabel}</span>
          </div>
          {item.subject ? <p className="mt-1 text-sm">{item.subject}</p> : null}
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{item.body}</p>
          {item.failureReason ? (
            <p className="mt-1 text-xs text-destructive">{item.failureReason}</p>
          ) : null}
          {item.consentContext ? (
            <p className="mt-1 text-xs text-muted-foreground">Consent: {item.consentContext}</p>
          ) : null}
          {item.relatedHref ? (
            <p className="mt-1 text-xs">
              <Link href={item.relatedHref} className="text-primary underline-offset-2 hover:underline">
                Open {item.contextLabel.toLowerCase()}
              </Link>
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            {formatDateTime(new Date(item.occurredAt), timeZone)}
          </p>
        </li>
      ))}
    </ol>
  );
}

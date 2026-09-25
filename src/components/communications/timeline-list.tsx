import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import type { CommunicationTimelineItem } from "@/lib/communications/timeline";

export function CommunicationTimelineList({
  items,
}: {
  items: CommunicationTimelineItem[];
}) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No recorded or projected communications yet.
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
            <span className="text-muted-foreground">{item.direction}</span>
            {item.source === "projected" ? (
              <span className="text-xs text-muted-foreground">projected</span>
            ) : null}
          </div>
          {item.subject ? <p className="mt-1 text-sm">{item.subject}</p> : null}
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{item.body}</p>
          {item.failureReason ? (
            <p className="mt-1 text-xs text-destructive">{item.failureReason}</p>
          ) : null}
          {item.consentContext ? (
            <p className="mt-1 text-xs text-muted-foreground">Consent: {item.consentContext}</p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(new Date(item.occurredAt))}</p>
        </li>
      ))}
    </ol>
  );
}

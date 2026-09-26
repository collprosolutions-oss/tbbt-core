"use client";

import { useMemo, useState } from "react";
import { CommunicationTimelineList } from "@/components/communications/timeline-list";
import { formatDateTime } from "@/lib/format";
import {
  filterCommunicationTimelineItems,
  type CommunicationTimelineItem,
  type CommunicationTimelineSummary,
} from "@/lib/communications/timeline";

function directionLabel(direction: CommunicationTimelineSummary["lastDirection"]) {
  if (direction === "INBOUND") return "Incoming";
  if (direction === "OUTBOUND") return "Outgoing";
  return "not recorded";
}

export function CustomerCommunicationTimeline({
  items,
  summary,
  timeZone,
}: {
  items: CommunicationTimelineItem[];
  summary: CommunicationTimelineSummary;
  timeZone: string;
}) {
  const [channel, setChannel] = useState("all");
  const [direction, setDirection] = useState("all");
  const channels = useMemo(
    () => [...new Set(items.map((item) => item.channel))].sort(),
    [items],
  );
  const filtered = filterCommunicationTimelineItems(items, { channel, direction });

  return (
    <div className="space-y-4">
      {summary.itemCount > 0 ? (
        <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-sm">
          <p className="font-medium">Last recorded communication</p>
          <p className="mt-1 text-muted-foreground">
            {summary.lastOccurredAt
              ? formatDateTime(new Date(summary.lastOccurredAt), timeZone)
              : "None"}
            {summary.lastChannel ? ` · ${summary.lastChannel}` : ""}
            {` · ${directionLabel(summary.lastDirection)}`}
            {summary.lastStatus ? ` · ${summary.lastStatus}` : ""}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No recorded communications yet.
        </p>
      )}

      {items.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="communication-channel-filter">
            Filter by channel
          </label>
          <select
            id="communication-channel-filter"
            aria-label="Filter by channel"
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            className="h-9 min-w-36 rounded-lg border border-input bg-transparent px-3 text-sm"
          >
            <option value="all">All channels</option>
            {channels.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="communication-direction-filter">
            Filter by direction
          </label>
          <select
            id="communication-direction-filter"
            aria-label="Filter by direction"
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
            className="h-9 min-w-36 rounded-lg border border-input bg-transparent px-3 text-sm"
          >
            <option value="all">All directions</option>
            <option value="INBOUND">Incoming</option>
            <option value="OUTBOUND">Outgoing</option>
            <option value="UNRECORDED">Direction not recorded</option>
          </select>
        </div>
      ) : null}

      {summary.itemCount > 0 && filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No recorded communications match those filters.
        </p>
      ) : null}
      {filtered.length > 0 ? (
        <CommunicationTimelineList items={filtered} timeZone={timeZone} />
      ) : null}
    </div>
  );
}

import Link from "next/link";
import { ComposeCommunicationForm } from "@/components/communications/compose-form";
import { MissedCallForm } from "@/components/communications/missed-call-form";
import { CommunicationTimelineList } from "@/components/communications/timeline-list";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import {
  COMMUNICATION_AREA_LABELS,
  COMMUNICATION_AREAS,
  type CommunicationArea,
} from "@/lib/communications/types";
import type { loadCommunicationsWorkspace } from "@/lib/communications/data";
import { cn } from "@/lib/utils";

type Source = Awaited<ReturnType<typeof loadCommunicationsWorkspace>>;

export function CommunicationsWorkspace({
  area,
  source,
}: {
  area: CommunicationArea;
  source: Source;
}) {
  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap items-center gap-1.5 border-b border-border/60 pb-3">
        {COMMUNICATION_AREAS.map((item) => {
          const href = item === "inbox" ? "/communications" : `/communications?area=${item}`;
          const active = item === area;
          return (
            <Link
              key={item}
              href={href}
              className={cn(
                "rounded-md border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {COMMUNICATION_AREA_LABELS[item]}
            </Link>
          );
        })}
      </nav>

      {area === "inbox" ? <InboxPanel source={source} /> : null}
      {area === "compose" ? (
        <Card>
          <CardHeader>
            <CardTitle>Compose</CardTitle>
            <CardDescription>
              Tenant-scoped owner/admin messages. AI suggestions never send themselves.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ComposeCommunicationForm
              customers={source.customers}
              selectedCustomerId={source.selectedCustomerId}
              emailReason={source.channelEligibility?.email.ownerReason ?? null}
              smsReason={source.channelEligibility?.sms.ownerReason ?? null}
              emailPermitted={Boolean(source.channelEligibility?.email.permitted && source.channelEligibility.email.available)}
              smsPermitted={Boolean(source.channelEligibility?.sms.permitted && source.channelEligibility.sms.available)}
            />
          </CardContent>
        </Card>
      ) : null}
      {area === "missed-calls" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Log a call</CardTitle>
              <CardDescription>Useful before live voice. This does not place a call.</CardDescription>
            </CardHeader>
            <CardContent>
              <MissedCallForm customers={source.customers} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Recent phone logs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {source.phoneLogs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No missed or manual calls yet.</p>
              ) : (
                source.phoneLogs.map((log) => (
                  <div key={log.id} className="rounded-md border border-border/70 p-3 text-sm">
                    <div className="flex flex-wrap gap-2">
                      <StatusBadge status={log.status} />
                      <span>{log.kind.replaceAll("_", " ")}</span>
                      <span className="text-muted-foreground">{log.customer?.name ?? "Unknown caller"}</span>
                    </div>
                    <p className="mt-1">{log.summary}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(log.occurredAt)}</p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
      {area === "receptionist" ? <ReceptionistPanel source={source} /> : null}
      {area === "automation" ? <AutomationPanel source={source} /> : null}
    </div>
  );
}

function InboxPanel({ source }: { source: Source }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Recent communications</CardTitle>
          <CardDescription>Durable records for this business only.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {source.inbox.length === 0 ? (
            <p className="text-sm text-muted-foreground">No communications recorded yet.</p>
          ) : (
            source.inbox.map((row) => (
              <div key={row.id} className="rounded-md border border-border/70 p-3 text-sm">
                <div className="flex flex-wrap gap-2">
                  <StatusBadge status={row.status} />
                  <span>{row.customer.name}</span>
                  <span className="text-muted-foreground">{row.channel}</span>
                </div>
                <p className="mt-1 line-clamp-3">{row.bodySnapshot}</p>
                {row.failureReason ? (
                  <p className="mt-1 text-xs text-destructive">{row.failureReason}</p>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Customer timeline</CardTitle>
          <CardDescription>
            {source.selectedCustomerId
              ? "Chronological records plus safe projections. Projections do not send."
              : "Add a customer to see a timeline."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CommunicationTimelineList items={source.timeline} />
        </CardContent>
      </Card>
    </div>
  );
}

function ReceptionistPanel({ source }: { source: Source }) {
  const readiness = source.receptionist;
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI receptionist foundation</CardTitle>
        <CardDescription>Provider-neutral domain only. Voice is not live.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>{readiness.voice.reason}</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Voice connected: {readiness.voice.connected ? "yes" : "no"}</li>
          <li>Email connected: {readiness.email.connected ? "yes" : "no"}</li>
          <li>SMS connected: {readiness.sms.connected ? "yes" : "no"}</li>
        </ul>
        <div className="space-y-2">
          {readiness.capabilities.map((item) => (
            <div key={item.capability} className="rounded-md border border-border/70 p-2">
              <p className="font-medium">{item.capability.replaceAll("_", " ")}</p>
              <p className="text-xs text-muted-foreground">
                {item.liveVoiceRequired
                  ? "Requires a connected voice provider."
                  : "Proposal or lookup only. AI cannot authorize business changes."}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function AutomationPanel({ source }: { source: Source }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Communication automation</CardTitle>
        <CardDescription>
          Uses the existing BusinessEvent / AutomationRule engine. Rules default off except
          owner-action suggestions. No second queue.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {source.rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">No communication rules seeded yet.</p>
        ) : (
          source.rules.map((rule) => (
            <div key={rule.id} className="rounded-md border border-border/70 p-3 text-sm">
              <div className="flex flex-wrap gap-2">
                <StatusBadge status={rule.enabled ? "ENABLED" : "DISABLED"} />
                <span>{rule.eventType}</span>
                <span className="text-muted-foreground">{rule.purpose}</span>
                <span className="text-muted-foreground">{rule.channel}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Delay {rule.delayMinutes} minutes · {rule.kind}
              </p>
            </div>
          ))
        )}
        <p className="text-xs text-muted-foreground">
          Enable or process rules from Business Health. Communications does not invent a second
          automation engine.
        </p>
      </CardContent>
    </Card>
  );
}

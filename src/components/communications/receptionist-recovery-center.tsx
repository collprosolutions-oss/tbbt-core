import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ReceptionistDispositionForm } from "@/components/communications/receptionist-disposition-form";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import type { ReceptionistRecoveryCenter } from "@/lib/communications/receptionist-recovery";

function kindLabel(kind: string) {
  return kind.replaceAll("_", " ");
}

function directionLabel(direction: string) {
  if (direction === "UNKNOWN") return "Direction not recorded";
  return direction;
}

export function ReceptionistRecoveryCenter({
  source,
  businessId,
}: {
  source: ReceptionistRecoveryCenter;
  businessId: string;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Recorded recovery facts</CardTitle>
          <CardDescription>
            This workspace reads PhoneInteraction and ReceptionistEvent rows
            already stored for this business. An authorized owner or admin
            can record that a callback-needed item was handled. That write
            does not place a call, send a text, send email, or invent a
            successful contact.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>{source.voiceReason}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-border/70 p-3">
              <p className="text-xs text-muted-foreground">Recorded missed calls</p>
              <p className="text-lg font-medium">{source.recordedMissedCallCount}</p>
            </div>
            <div className="rounded-md border border-border/70 p-3">
              <p className="text-xs text-muted-foreground">Callback needed</p>
              <p className="text-lg font-medium">{source.recordedCallbackNeededCount}</p>
            </div>
            <div className="rounded-md border border-border/70 p-3">
              <p className="text-xs text-muted-foreground">Recorded inbound events</p>
              <p className="text-lg font-medium">{source.recordedInboundEventCount}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Queue is bounded to {source.queueLimit} items needing recorded
            attention. Unknown stays Unknown. Log Lead remains the canonical
            capture path and does not accept prefill from this page.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Attention queue</CardTitle>
          <CardDescription>
            {source.queue.length === 0
              ? "No attention items were found in the bounded recent recovery scan."
              : `${source.queue.length} recorded item${source.queue.length === 1 ? "" : "s"} · ${source.knownCustomerCount} known · ${source.unknownCallerCount} unknown`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {source.queue.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Record a missed call or inbound receptionist event from
              Communications when you want it to appear here.
            </p>
          ) : (
            source.queue.map((item) => (
              <article
                key={`${item.source}:${item.id}`}
                className="space-y-2 rounded-md border border-border/70 p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={item.status} />
                  <span className="font-medium">{kindLabel(item.kind)}</span>
                  <span className="text-muted-foreground">{directionLabel(item.direction)}</span>
                  {item.callbackNeeded ? <StatusBadge status="CALLBACK_NEEDED" /> : null}
                </div>
                <p>
                  {item.customerKnown && item.customer ? (
                    <Link href={item.customer.href} className="font-medium text-primary underline-offset-4 hover:underline">
                      {item.customer.name}
                    </Link>
                  ) : (
                    <span className="font-medium">Unknown caller</span>
                  )}
                  {item.callerLast4 ? (
                    <span className="text-muted-foreground"> · ending in {item.callerLast4}</span>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(new Date(item.occurredAt), source.timeZone)}
                </p>
                {item.summary ? <p>{item.summary}</p> : null}
                {item.attentionReasons.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                    {item.attentionReasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : null}
                {item.receptionistKind ? (
                  <p className="text-xs text-muted-foreground">
                    Receptionist {kindLabel(item.receptionistKind)}
                    {item.receptionistStatus ? ` · ${kindLabel(item.receptionistStatus)}` : ""}
                  </p>
                ) : null}
                {item.request ? (
                  <p className="text-xs">
                    Request:{" "}
                    <Link href={item.request.href} className="text-primary underline-offset-4 hover:underline">
                      {item.request.label}
                    </Link>
                  </p>
                ) : null}
                {item.job ? (
                  <p className="text-xs">
                    Job:{" "}
                    <Link href={item.job.href} className="text-primary underline-offset-4 hover:underline">
                      {item.job.label}
                    </Link>
                  </p>
                ) : null}
                {item.lastCustomerCommunication ? (
                  <p className="text-xs text-muted-foreground">
                    Last recorded customer communication:{" "}
                    {item.lastCustomerCommunication.channel} {item.lastCustomerCommunication.direction}{" "}
                    {item.lastCustomerCommunication.status}
                    {item.lastCustomerCommunication.isThisCallRecord
                      ? " · this call is the last recorded communication"
                      : item.laterCommunicationRecorded
                        ? " · a later communication is recorded"
                        : " · No later customer communication is recorded"}
                    {" · "}
                    {formatDateTime(
                      new Date(item.lastCustomerCommunication.occurredAt),
                      source.timeZone,
                    )}
                  </p>
                ) : item.customerKnown ? (
                  <p className="text-xs text-muted-foreground">
                    No later customer communication is recorded.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Caller identity is unknown, so no customer communication history is attached.
                  </p>
                )}
                <div className="flex flex-wrap items-start gap-2 pt-1">
                  {item.customer ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={item.customer.href}>Open customer</Link>
                    </Button>
                  ) : (
                    <Button asChild size="sm" variant="outline">
                      <Link href={source.logLeadHref}>Log lead</Link>
                    </Button>
                  )}
                  {item.canRecordDisposition ? (
                    <ReceptionistDispositionForm
                      phoneInteractionId={item.id}
                      businessId={businessId}
                    />
                  ) : null}
                </div>
              </article>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}


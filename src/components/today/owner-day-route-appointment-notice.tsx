"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  sendOwnerDayRouteAppointmentNoticeAction,
  type OwnerDayRouteAppointmentNoticeActionState,
} from "@/app/actions/owner-day-route";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE,
  DAY_ROUTE_APPOINTMENT_NOTICE_FORM_NOTE,
  DAY_ROUTE_APPOINTMENT_NOTICE_SUBMIT_LABEL,
  serializeDayRouteAppointmentNoticeReviewSnapshot,
  type OwnerDayRouteAppointmentNoticePreview,
} from "@/lib/owner-day-route-appointment-notice";

const initialState: OwnerDayRouteAppointmentNoticeActionState = {};

export function OwnerDayRouteAppointmentNoticeForm({
  notice,
  timeZone,
}: {
  notice: OwnerDayRouteAppointmentNoticePreview;
  timeZone: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    sendOwnerDayRouteAppointmentNoticeAction,
    initialState,
  );

  useEffect(() => {
    if (state.ok) {
      router.refresh();
    }
  }, [state.ok, state.message, router]);

  return (
    <form action={formAction} className="mt-3 space-y-3 rounded-lg border border-border/80 p-3">
      <input type="hidden" name="jobId" value={notice.jobId} />
      <input
        type="hidden"
        name="scheduleSnapshot"
        value={
          notice.customerId && notice.destinationFingerprint
            ? serializeDayRouteAppointmentNoticeReviewSnapshot({
                ...notice.snapshot,
                customerId: notice.customerId,
                destinationFingerprint: notice.destinationFingerprint,
              })
            : ""
        }
      />
      <input type="hidden" name="timeZone" value={timeZone} />
      <input type="hidden" name="channel" value={notice.channel ?? ""} />
      <input type="hidden" name="proposalId" value={String(notice.proposalId)} />
      <input type="hidden" name="customerId" value={notice.customerId ?? ""} />
      <input
        type="hidden"
        name="destinationFingerprint"
        value={notice.destinationFingerprint ?? ""}
      />
      <input
        type="hidden"
        name="confirmSend"
        value={DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE}
      />
      <p className="text-sm font-medium">Review appointment notice</p>
      <p className="text-xs text-muted-foreground">{DAY_ROUTE_APPOINTMENT_NOTICE_FORM_NOTE}</p>
      <dl className="space-y-1 text-sm">
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="text-muted-foreground">Recorded window</dt>
          <dd className="tabular-nums">{notice.appointmentWindowLabel}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="text-muted-foreground">Channel</dt>
          <dd>{notice.channelLabel}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="text-muted-foreground">Recipient</dt>
          <dd>{notice.recipientLabel}</dd>
        </div>
      </dl>
      {notice.unavailableReason ? (
        <p className="text-sm text-amber-800 dark:text-amber-300">{notice.unavailableReason}</p>
      ) : null}
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      ) : null}
      {notice.offerSend ? (
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? "Sending…" : DAY_ROUTE_APPOINTMENT_NOTICE_SUBMIT_LABEL}
        </Button>
      ) : null}
    </form>
  );
}

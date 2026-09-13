import { AlertTriangle } from "lucide-react";
import {
  OWNER_DIFFERENT_TIME_ATTENTION_HEADING,
  OWNER_RECONFIRMATION_ATTENTION_HEADING,
  type OwnerAppointmentAttentionKind,
} from "@/lib/appointment-confirmation";
import { formatAppointmentWhen } from "@/lib/format";

export function OwnerAppointmentAttentionBanner({
  kind,
  customerNote,
  scheduledAt,
  notificationSent,
}: {
  kind: OwnerAppointmentAttentionKind;
  customerNote: string | null;
  scheduledAt: Date;
  notificationSent: boolean;
}) {
  const heading =
    kind === "DIFFERENT_TIME"
      ? OWNER_DIFFERENT_TIME_ATTENTION_HEADING
      : OWNER_RECONFIRMATION_ATTENTION_HEADING;
  const when = formatAppointmentWhen(scheduledAt);

  return (
    <div
      role="status"
      className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden />
        <div className="min-w-0 space-y-2">
          <p className="font-semibold tracking-wide">{heading}</p>
          {kind === "DIFFERENT_TIME" ? (
            <>
              <p>Customer requested a different appointment time.</p>
              {customerNote ?               <p>Customer note: “{customerNote}”</p> : null}
              <p>Current appointment: {when}</p>
              <p>Action required: Reschedule the appointment or contact the customer.</p>
            </>
          ) : (
            <>
              <p>New proposed appointment: {when}</p>
              <p>The previous customer confirmation is no longer valid for this appointment.</p>
              <p>
                {notificationSent
                  ? "The customer has been notified and must confirm the new appointment."
                  : "The customer must confirm the new appointment."}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

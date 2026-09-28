"use client";

import { useActionState } from "react";
import {
  setStudioWeeklyReminderOwnerSmsAction,
  setStudioWeeklyReviewReminderOptInAction,
  type MarketingActionState,
} from "@/app/actions/marketing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OPT_IN_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OWNER_SMS_OPT_IN_MESSAGE,
  STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED,
  STUDIO_WEEKLY_REMINDER_SMS_UNCONFIRMED,
  STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE,
  canManageStudioWeeklyReminder,
} from "@/lib/marketing";
import type { MarketingSource } from "@/lib/marketing-data";

const initial: MarketingActionState = {};

export function StudioWeeklyReminderControls({
  reminder,
  viewerRole,
}: {
  reminder: MarketingSource["weeklyReminder"];
  viewerRole: string;
}) {
  const [state, action, pending] = useActionState(
    setStudioWeeklyReviewReminderOptInAction,
    initial,
  );
  const [smsState, smsAction, smsPending] = useActionState(
    setStudioWeeklyReminderOwnerSmsAction,
    initial,
  );
  const canManage = canManageStudioWeeklyReminder(viewerRole);
  const smsLabel =
    reminder.reminder?.smsLabel ||
    reminder.delivery.smsLabel ||
    STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED;

  if (!reminder.available) {
    return (
      <div className="space-y-2 rounded-lg border border-border/70 p-3">
        <p className="text-sm font-medium">Weekly review reminder</p>
        <p className="text-sm">{STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Weekly review reminder</p>
          <p className="text-xs text-muted-foreground">{STUDIO_WEEKLY_REMINDER_OPT_IN_MESSAGE}</p>
        </div>
        {smsLabel ? <Badge variant="outline">{smsLabel}</Badge> : null}
      </div>
      {reminder.optedIn ? (
        <p className="text-sm">
          {reminder.copy ?? "Reminders are on. No packages are awaiting review this week."}
        </p>
      ) : (
        <p className="text-sm">Weekly reminders are off.</p>
      )}
      <p className="text-xs text-muted-foreground">{STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE}</p>
      {reminder.reminder?.smsStatus === "ACCEPTED" || reminder.reminder?.smsStatus === "SENT" ? (
        <p className="text-xs text-muted-foreground">{STUDIO_WEEKLY_REMINDER_SMS_UNCONFIRMED}</p>
      ) : null}
      {canManage ? (
        <form action={action}>
          <input type="hidden" name="optedIn" value={reminder.optedIn ? "false" : "true"} />
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            {pending
              ? "Saving…"
              : reminder.optedIn
                ? "Turn weekly reminder off"
                : "Turn weekly reminder on"}
          </Button>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">{STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE}</p>
      )}
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}

      <p className="text-xs text-muted-foreground">{STUDIO_WEEKLY_REMINDER_OWNER_SMS_OPT_IN_MESSAGE}</p>
      {reminder.ownerSmsStopped ? (
        <p className="text-xs text-muted-foreground">
          This OWNER number sent STOP. Weekly owner SMS stays off until START or a new number is saved.
        </p>
      ) : null}
      {reminder.ownerSmsBlocked ? (
        <p className="text-xs text-muted-foreground">
          The provider blocked this OWNER number. Customer consent was not changed.
        </p>
      ) : null}
      {!canManage && reminder.ownerSmsToMasked ? (
        <p className="text-xs text-muted-foreground">OWNER SMS {reminder.ownerSmsToMasked}</p>
      ) : null}
      {canManage ? (
        <form action={smsAction} className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor="owner-studio-sms-to">OWNER SMS number</Label>
            <Input
              id="owner-studio-sms-to"
              name="ownerSmsTo"
              type="tel"
              defaultValue={reminder.ownerSmsTo ?? ""}
              placeholder="+15551234567"
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              name="ownerSmsOptedIn"
              value="true"
              defaultChecked={reminder.ownerSmsOptedIn}
            />
            Send the weekly reminder to this OWNER number
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={smsPending}>
            {smsPending ? "Saving…" : "Save OWNER SMS destination"}
          </Button>
        </form>
      ) : null}
      {smsState.error ? <p className="text-xs text-destructive">{smsState.error}</p> : null}
      {smsState.message ? <p className="text-xs text-muted-foreground">{smsState.message}</p> : null}
    </div>
  );
}

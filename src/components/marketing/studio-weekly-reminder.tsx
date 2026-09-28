"use client";

import { useActionState } from "react";
import {
  setStudioWeeklyReviewReminderOptInAction,
  type MarketingActionState,
} from "@/app/actions/marketing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OPT_IN_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE,
  STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED,
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
  const canManage = canManageStudioWeeklyReminder(viewerRole);
  const smsLabel =
    reminder.reminder?.smsLabel ||
    reminder.delivery.smsLabel ||
    STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED;

  return (
    <div className="space-y-2 rounded-lg border border-border/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Weekly review reminder</p>
          <p className="text-xs text-muted-foreground">{STUDIO_WEEKLY_REMINDER_OPT_IN_MESSAGE}</p>
        </div>
        {smsLabel === STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED ? (
          <Badge variant="outline">{STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED}</Badge>
        ) : null}
      </div>
      {reminder.optedIn ? (
        <p className="text-sm">
          {reminder.copy ?? "Reminders are on. No packages are awaiting review this week."}
        </p>
      ) : (
        <p className="text-sm">Weekly reminders are off.</p>
      )}
      <p className="text-xs text-muted-foreground">{STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE}</p>
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
    </div>
  );
}

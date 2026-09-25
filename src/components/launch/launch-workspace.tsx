"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  completeLaunchStepAction,
  deferLaunchStepAction,
  resumeLaunchLaterAction,
  skipLaunchStepAction,
  type LaunchActionState,
} from "@/app/actions/business-launch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BUSINESS_STAGE_LABELS,
  BUSINESS_STAGES,
  LAUNCH_NO_PUBLISH_MESSAGE,
  LAUNCH_TRADE_CONFIRM_ONLY_MESSAGE,
  PRICING_APPROACH_LABELS,
  PRICING_APPROACHES,
  type LaunchStepKey,
} from "@/lib/business-launch";
import type { LaunchWorkspace } from "@/lib/business-launch-data";
import { cn } from "@/lib/utils";

const initial: LaunchActionState = {};

const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

export function LaunchWorkspace({
  workspace,
  step,
}: {
  workspace: LaunchWorkspace;
  step: LaunchStepKey;
}) {
  const [saveState, saveAction, savePending] = useActionState(completeLaunchStepAction, initial);
  const [skipState, skipAction, skipPending] = useActionState(skipLaunchStepAction, initial);
  const [deferState, deferAction, deferPending] = useActionState(deferLaunchStepAction, initial);
  const current = workspace.stepMeta.find((item) => item.key === step) ?? workspace.stepMeta[0];
  const status = workspace.progress.steps.find((row) => row.stepKey === step)?.status ?? "PENDING";

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Setup progress</CardTitle>
          <CardDescription>
            {workspace.progress.completedCount} of {workspace.progress.definedStepCount} defined
            steps complete ({workspace.progress.progressPercent}%). Skipped and deferred are not
            counted as complete.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary"
              style={{ width: `${workspace.progress.progressPercent}%` }}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Recommended next:{" "}
            {workspace.progress.recommendedNext
              ? workspace.stepMeta.find((item) => item.key === workspace.progress.recommendedNext)
                  ?.label
              : "All defined steps are resolved."}
          </p>
          <nav className="space-y-1">
            {workspace.stepMeta.map((item) => {
              const row = workspace.progress.steps.find((stepRow) => stepRow.stepKey === item.key);
              return (
                <Link
                  key={item.key}
                  href={`/launch?step=${item.key}`}
                  className={cn(
                    "flex items-center justify-between rounded-md px-2 py-1.5 text-sm",
                    item.key === step ? "bg-primary/10 text-primary" : "hover:bg-accent",
                  )}
                >
                  <span>{item.label}</span>
                  <Badge variant={row?.status === "COMPLETED" ? "success" : "outline"}>
                    {row?.status ?? "PENDING"}
                  </Badge>
                </Link>
              );
            })}
          </nav>
          <form action={resumeLaunchLaterAction}>
            <Button type="submit" variant="ghost" className="w-full">
              Resume later
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{current.label}</CardTitle>
          <CardDescription>
            {current.summary} Current state: {status}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {saveState.error || skipState.error || deferState.error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {saveState.error || skipState.error || deferState.error}
              </AlertDescription>
            </Alert>
          ) : null}
          {saveState.message || skipState.message || deferState.message ? (
            <Alert>
              <AlertDescription>
                {saveState.message || skipState.message || deferState.message}
              </AlertDescription>
            </Alert>
          ) : null}

          <form action={saveAction} className="space-y-4">
            <input type="hidden" name="stepKey" value={step} />
            <StepFields step={step} workspace={workspace} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={savePending}>
                Save this step
              </Button>
              <Button formAction={skipAction} type="submit" variant="outline" disabled={skipPending}>
                Skip
              </Button>
              <Button formAction={deferAction} type="submit" variant="ghost" disabled={deferPending}>
                Defer
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function StepFields({ step, workspace }: { step: LaunchStepKey; workspace: LaunchWorkspace }) {
  if (step === "identity") {
    return (
      <>
        <Field id="name" label="Business name" defaultValue={workspace.business.name} />
        <Field id="phone" label="Public phone" defaultValue={workspace.business.publicPhone} />
        <Field id="email" label="Public email" defaultValue={workspace.business.publicEmail} />
        <Field id="website" label="Public website" defaultValue={workspace.business.publicWebsite} />
      </>
    );
  }
  if (step === "trades") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{LAUNCH_TRADE_CONFIRM_ONLY_MESSAGE}</p>
        {workspace.trades.map((trade) => (
          <label key={trade.tradeCode} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="confirmTrades" value={trade.tradeCode} defaultChecked />
            {trade.label}
          </label>
        ))}
      </div>
    );
  }
  if (step === "service_area") {
    return (
      <>
        <input type="hidden" name="phone" value={workspace.business.publicPhone} />
        <input type="hidden" name="email" value={workspace.business.publicEmail} />
        <input type="hidden" name="website" value={workspace.business.publicWebsite} />
        <Field
          id="serviceAreaLabel"
          label="Service area"
          defaultValue={workspace.business.publicServiceAreaLabel}
        />
        <Field id="serviceAreaCity" label="Primary city (optional)" />
        <Field id="serviceAreaRegion" label="Region (optional)" />
      </>
    );
  }
  if (step === "services") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Existing services stay where they are. New names are created as custom-quote items with no
          price.
        </p>
        <ul className="list-disc pl-5 text-sm">
          {workspace.services.map((service) => (
            <li key={service.id}>
              {service.name} · {service.pricingMode}
            </li>
          ))}
        </ul>
        <Label htmlFor="serviceNames">Add services (one per line)</Label>
        <textarea id="serviceNames" name="serviceNames" className="min-h-24 w-full rounded-md border bg-background p-2 text-sm" />
      </div>
    );
  }
  if (step === "pricing") {
    return (
      <>
        <Label htmlFor="pricingApproach">Pricing approach</Label>
        <select
          id="pricingApproach"
          name="pricingApproach"
          defaultValue={workspace.settings.pricingApproach ?? ""}
          className="w-full rounded-md border bg-background p-2 text-sm"
        >
          <option value="">Choose…</option>
          {PRICING_APPROACHES.map((value) => (
            <option key={value} value={value}>
              {PRICING_APPROACH_LABELS[value]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="laborMinimumEnabled" defaultChecked={workspace.business.laborMinimumEnabled} />
          Enable a minimum service charge
        </label>
        <Field
          id="laborMinimumAmount"
          label="Minimum service charge"
          defaultValue={workspace.business.laborMinimumAmount ?? ""}
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="confirmPricing" />
          I confirm this pricing change for future work only
        </label>
      </>
    );
  }
  if (step === "hours" || step === "scheduling") {
    return (
      <>
        <Field
          id="workStartMinutes"
          label="Work start (minutes from midnight)"
          defaultValue={String(workspace.settings.workStartMinutes)}
        />
        <Field
          id="workEndMinutes"
          label="Work end (minutes from midnight)"
          defaultValue={String(workspace.settings.workEndMinutes)}
        />
        <div className="flex flex-wrap gap-3">
          {WEEKDAYS.map((day) => (
            <label key={day.value} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                name="workingWeekdays"
                value={day.value}
                defaultChecked={workspace.settings.workingWeekdays.includes(day.value)}
              />
              {day.label}
            </label>
          ))}
        </div>
        <Field
          id="schedulingBufferMinutes"
          label="Scheduling buffer (minutes)"
          defaultValue={String(workspace.settings.schedulingBufferMinutes)}
        />
        {step === "scheduling" ? (
          <div className="space-y-1.5">
            <Label htmlFor="schedulingNotes">Scheduling notes</Label>
            <textarea
              id="schedulingNotes"
              name="schedulingNotes"
              defaultValue={workspace.settings.schedulingPreferenceNotes ?? ""}
              className="min-h-20 w-full rounded-md border bg-background p-2 text-sm"
            />
          </div>
        ) : null}
      </>
    );
  }
  if (step === "team") {
    return (
      <div className="space-y-1.5">
        <p className="text-sm text-muted-foreground">
          Notes only. Invite people from <Link href="/team" className="underline">Team</Link>.
        </p>
        <textarea
          id="teamNotes"
          name="teamNotes"
          defaultValue={workspace.settings.teamStructureNotes ?? ""}
          className="min-h-24 w-full rounded-md border bg-background p-2 text-sm"
        />
      </div>
    );
  }
  if (step === "payments") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Customer payment status: {workspace.paymentStatus}. This is not TBBT software billing.
        </p>
        <textarea
          id="paymentNotes"
          name="paymentNotes"
          defaultValue={workspace.settings.paymentPreferenceNotes ?? ""}
          className="min-h-24 w-full rounded-md border bg-background p-2 text-sm"
        />
      </div>
    );
  }
  if (step === "communication") {
    return (
      <>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="estimateCommunicationEnabled" defaultChecked={workspace.settings.estimateCommunicationEnabled} />
          Estimate communication
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="scheduleNotificationEnabled" defaultChecked={workspace.settings.scheduleNotificationEnabled} />
          Schedule notifications
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="invoiceCommunicationEnabled" defaultChecked={workspace.settings.invoiceCommunicationEnabled} />
          Invoice communication
        </label>
      </>
    );
  }
  if (step === "brand_voice") {
    return (
      <>
        <div className="space-y-1.5">
          <Label htmlFor="brandVoice">Brand voice</Label>
          <textarea
            id="brandVoice"
            name="brandVoice"
            defaultValue={workspace.settings.marketingBrandVoice}
            className="min-h-20 w-full rounded-md border bg-background p-2 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="identityNotes">Identity notes</Label>
          <textarea
            id="identityNotes"
            name="identityNotes"
            defaultValue={workspace.settings.marketingIdentityNotes}
            className="min-h-20 w-full rounded-md border bg-background p-2 text-sm"
          />
        </div>
      </>
    );
  }
  if (step === "website") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{LAUNCH_NO_PUBLISH_MESSAGE}</p>
        <p className="text-sm">
          Website setup {workspace.business.websiteSetupCompletedAt ? "finished" : "still pending"}.{" "}
          {workspace.websitePublished ? "A snapshot is published." : "No snapshot is published."}
        </p>
        <Label htmlFor="about">About copy</Label>
        <textarea
          id="about"
          name="about"
          defaultValue={workspace.settings.approvedPublicAboutCopy}
          className="min-h-24 w-full rounded-md border bg-background p-2 text-sm"
        />
        <Button asChild variant="outline">
          <Link href="/settings?section=website-publish">Open Website Publish</Link>
        </Button>
      </div>
    );
  }
  if (step === "goals") {
    return (
      <>
        <Field id="goalTitle" label="Goal" />
        <div className="space-y-1.5">
          <Label htmlFor="goalDescription">Notes</Label>
          <textarea id="goalDescription" name="goalDescription" className="min-h-20 w-full rounded-md border bg-background p-2 text-sm" />
        </div>
        <ul className="list-disc pl-5 text-sm">
          {workspace.goals.map((goal) => (
            <li key={goal.id}>
              {goal.title} · {goal.status}
            </li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <div className="space-y-2">
      <Label htmlFor="businessStage">Current stage</Label>
      <select
        id="businessStage"
        name="businessStage"
        defaultValue={workspace.settings.businessStage ?? ""}
        className="w-full rounded-md border bg-background p-2 text-sm"
      >
        <option value="">Choose…</option>
        {BUSINESS_STAGES.map((value) => (
          <option key={value} value={value}>
            {BUSINESS_STAGE_LABELS[value]}
          </option>
        ))}
      </select>
    </div>
  );
}

function Field({
  id,
  label,
  defaultValue,
}: {
  id: string;
  label: string;
  defaultValue?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} defaultValue={defaultValue} />
    </div>
  );
}

import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveMonthlyBusinessGoalAction } from "@/app/actions/monthly-goals";
import { formatMoney } from "@/lib/format";
import {
  INVOICES_PAID_FACT_MESSAGE,
  JOBS_COMPLETED_FACT_MESSAGE,
  MONTHLY_GOAL_METRIC_LABELS,
  REVENUE_RECEIVED_FACT_MESSAGE,
  TARGET_NOT_BANK_BALANCE_MESSAGE,
  TARGET_NOT_FORECAST_MESSAGE,
  UNCLOCKED_COMPLETED_JOBS_MESSAGE,
  monthlyGoalHref,
  type MonthlyGoalProgress,
} from "@/lib/monthly-goals";
import type { MonthlyGoalsWorkspaceData } from "@/lib/monthly-goals-data";

function formatActual(progress: MonthlyGoalProgress) {
  if (progress.metric === "revenue-received") {
    return `${formatMoney(progress.actual)}${progress.actualIncomplete ? " (sample)" : ""}`;
  }
  return `${progress.actual}${progress.actualIncomplete ? " (sample)" : ""}`;
}

function formatGoal(progress: MonthlyGoalProgress) {
  if (progress.goal == null) return "No target set";
  if (progress.metric === "revenue-received") return formatMoney(progress.goal);
  return String(progress.goal);
}

function formatRemaining(progress: MonthlyGoalProgress) {
  if (progress.status === "no-target") return "Set a target to compare";
  if (progress.status === "actual-incomplete") return "Unavailable — actuals are incomplete";
  if (progress.remaining == null) return "Unavailable";
  if (progress.metric === "revenue-received") return formatMoney(progress.remaining);
  return String(progress.remaining);
}

function formatPercent(progress: MonthlyGoalProgress) {
  if (progress.percent == null) return "Unavailable";
  return `${progress.percent}% of target`;
}

function statusLabel(progress: MonthlyGoalProgress) {
  if (progress.status === "met") return "Target met from recorded facts";
  if (progress.status === "short") return "Short of target";
  if (progress.status === "actual-incomplete") return "Recorded actuals incomplete";
  if (progress.status === "no-target") return "Target not set";
  return "Unavailable";
}

function ProgressCard({
  progress,
  description,
}: {
  progress: MonthlyGoalProgress;
  description: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{MONTHLY_GOAL_METRIC_LABELS[progress.metric]}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Recorded actual</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{formatActual(progress)}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Target</p>
            <p className="mt-1 text-sm font-medium tabular-nums">{formatGoal(progress)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Remaining</p>
            <p className="mt-1 text-sm font-medium tabular-nums">{formatRemaining(progress)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Progress</p>
            <p className="mt-1 text-sm font-medium tabular-nums">{formatPercent(progress)}</p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{statusLabel(progress)}</p>
        {progress.notes.map((note) => (
          <p key={note} className="text-xs text-muted-foreground">
            {note}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

export function MonthlyGoalsWorkspace({ workspace }: { workspace: MonthlyGoalsWorkspaceData }) {
  const { period, progress, targets, canWrite, goalsAvailable, unavailableMessage, unclockedCompletedJobs } =
    workspace;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{period.label}</p>
          <p className="text-xs text-muted-foreground">
            {period.key} · {period.timeZone} month bounds
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={monthlyGoalHref(period.previousKey)}>Previous month</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={monthlyGoalHref(period.nextKey)}>Next month</Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What these numbers are</CardTitle>
          <CardDescription>
            {TARGET_NOT_FORECAST_MESSAGE} {TARGET_NOT_BANK_BALANCE_MESSAGE}
          </CardDescription>
        </CardHeader>
      </Card>

      {!goalsAvailable ? (
        <Card>
          <CardHeader>
            <CardTitle>Targets unavailable</CardTitle>
            <CardDescription>{unavailableMessage}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {unclockedCompletedJobs > 0 ? (
        <p className="text-sm text-muted-foreground">
          {unclockedCompletedJobs} completed job{unclockedCompletedJobs === 1 ? "" : "s"} have no
          JOB_COMPLETED event. {UNCLOCKED_COMPLETED_JOBS_MESSAGE}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <ProgressCard progress={progress.jobsCompleted} description={JOBS_COMPLETED_FACT_MESSAGE} />
        <ProgressCard progress={progress.invoicesPaid} description={INVOICES_PAID_FACT_MESSAGE} />
        <ProgressCard progress={progress.revenueReceived} description={REVENUE_RECEIVED_FACT_MESSAGE} />
      </div>

      {canWrite && goalsAvailable ? (
        <Card>
          <CardHeader>
            <CardTitle>Set this month&apos;s targets</CardTitle>
            <CardDescription>
              OWNER only. Leave a field blank to clear that target. ADMIN can view progress but cannot
              change targets.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={saveMonthlyBusinessGoalAction} className="grid gap-4 sm:grid-cols-3">
              <input type="hidden" name="month" value={period.key} />
              <div className="space-y-2">
                <Label htmlFor="jobsCompleted">Jobs completed target</Label>
                <Input
                  id="jobsCompleted"
                  name="jobsCompleted"
                  inputMode="numeric"
                  defaultValue={targets.jobsCompleted ?? ""}
                  placeholder="e.g. 12"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invoicesPaid">Invoices paid target</Label>
                <Input
                  id="invoicesPaid"
                  name="invoicesPaid"
                  inputMode="numeric"
                  defaultValue={targets.invoicesPaid ?? ""}
                  placeholder="e.g. 10"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="revenueReceived">Revenue received target</Label>
                <Input
                  id="revenueReceived"
                  name="revenueReceived"
                  inputMode="decimal"
                  defaultValue={targets.revenueReceived ?? ""}
                  placeholder="e.g. 8000"
                />
              </div>
              <div className="sm:col-span-3">
                <Button type="submit">Save targets</Button>
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      ) : null}

      {!canWrite ? (
        <p className="text-sm text-muted-foreground">
          ADMIN may view these recorded actuals and owner targets. Only OWNER can set or change
          monthly goals.
        </p>
      ) : null}
    </div>
  );
}

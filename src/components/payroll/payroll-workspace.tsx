"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import {
  addPayrollItemAction,
  authorizePayrollRunAction,
  cancelPayrollRunAction,
  changePayrollPeriodAction,
  createPayrollRunAction,
  markPayrollProcessedAction,
  removePayrollItemAction,
  reopenPayrollRunAction,
  reviewPayrollRunAction,
  type PayrollActionState,
} from "@/app/actions/payroll";
import type { PayrollReviewItem, PayrollWorkspaceData } from "@/components/payroll/types";
import { EmptyState } from "@/components/empty-state";
import { FounderRegion } from "@/components/founder-design/region";
import { PageHeaderControls } from "@/components/page-header-controls";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const initialState: PayrollActionState = {};

export function PayrollWorkspace({
  workspace,
  selectedItemId,
}: {
  workspace: PayrollWorkspaceData;
  selectedItemId: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(selectedItemId);
  const [mobileOpen, setMobileOpen] = useState(false);
  const selected = workspace.items.find((item) => item.id === selectedId) ?? workspace.items[0] ?? null;

  function selectItem(id: string) {
    setSelectedId(id);
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1279px)").matches) {
      setMobileOpen(true);
    }
  }

  return (
    <>
      <PageHeaderControls
        title="Payroll"
        actions={
          workspace.runId ? (
            <Button size="sm" variant="outline" asChild>
              <Link href="/time-cards?view=approvals">Open Time Cards</Link>
            </Button>
          ) : (
            <Button size="sm" asChild>
              <Link href="#create-payroll-run">Start payroll run</Link>
            </Button>
          )
        }
      />

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,340px)]">
        <div className="min-w-0 space-y-5">
          <FounderRegion id="table" className="min-w-0">
            <PayrollReview
              workspace={workspace}
              selectedId={selected?.id ?? null}
              onSelect={selectItem}
            />
          </FounderRegion>
          <FounderRegion id="history">
            <PayrollHistory history={workspace.history} currentRunId={workspace.runId} />
          </FounderRegion>
        </div>

        <div className="min-w-0 space-y-5">
          <FounderRegion id="readiness">
            <ReadinessPanel workspace={workspace} />
          </FounderRegion>
          <div className="hidden xl:block">
            <FounderRegion id="details">
              <WorkerDetail item={selected} locked={workspace.locked} />
            </FounderRegion>
          </div>
        </div>
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{selected?.workerName ?? "Worker"}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            <WorkerDetail item={selected} locked={workspace.locked} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function PayrollReview({
  workspace,
  selectedId,
  onSelect,
}: {
  workspace: PayrollWorkspaceData;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payroll Review</CardTitle>
        <CardDescription>
          Approved Time Cards only. OT hours are informational — OT pay rules not configured.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <PeriodForm workspace={workspace} />
        {workspace.items.length === 0 ? (
          <EmptyState
            title="No approved weeks in this period"
            description="Approve Time Cards first. Unapproved or running time never enters payroll totals."
          />
        ) : (
          <>
            <div className="hidden min-w-0 overflow-x-auto md:block">
              <table className="w-full min-w-0 text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-[var(--tbbt-table-header-py,14px)] pr-3">Worker</th>
                    <th className="py-[var(--tbbt-table-header-py,14px)] pr-3">Hours</th>
                    <th className="py-[var(--tbbt-table-header-py,14px)] pr-3">Regular</th>
                    <th className="py-[var(--tbbt-table-header-py,14px)] pr-3">OT Hours</th>
                    <th className="py-[var(--tbbt-table-header-py,14px)] pr-3">Wage snapshot</th>
                    <th className="py-[var(--tbbt-table-header-py,14px)] pr-3">Gross labor</th>
                    <th className="py-[var(--tbbt-table-header-py,14px)] pr-3">Timesheet</th>
                    <th className="py-[var(--tbbt-table-header-py,14px)]">Readiness</th>
                  </tr>
                </thead>
                <tbody>
                  {workspace.items.map((item) => (
                    <tr
                      key={item.id}
                      className={cn(
                        "cursor-pointer border-b last:border-0",
                        selectedId === item.id && "bg-primary/10",
                      )}
                      onClick={() => onSelect(item.id)}
                    >
                      <td className="py-[var(--tbbt-table-row-py,16px)] pr-3">
                        <p className="font-medium">{item.workerName}</p>
                        {!item.workerActive ? (
                          <p className="text-xs text-muted-foreground">Inactive · historical</p>
                        ) : null}
                      </td>
                      <td className="py-[var(--tbbt-table-row-py,16px)] pr-3">{item.approvedHoursLabel}</td>
                      <td className="py-[var(--tbbt-table-row-py,16px)] pr-3">{item.regularHoursLabel}</td>
                      <td className="py-[var(--tbbt-table-row-py,16px)] pr-3">
                        <span>{item.overtimeHoursLabel}</span>
                        <span className="block text-[11px] text-muted-foreground">informational</span>
                      </td>
                      <td className="py-[var(--tbbt-table-row-py,16px)] pr-3">{item.wageSnapshotLabel}</td>
                      <td className="py-[var(--tbbt-table-row-py,16px)] pr-3 font-medium">{item.grossLabel}</td>
                      <td className="py-[var(--tbbt-table-row-py,16px)] pr-3">{item.timesheetStatusLabel}</td>
                      <td className="py-[var(--tbbt-table-row-py,16px)]">
                        <StatusBadge status={item.readiness} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-2 md:hidden">
              {workspace.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    "flex w-full flex-col gap-1 rounded-lg border px-3 py-3 text-left",
                    selectedId === item.id ? "border-primary bg-primary/10" : "border-border",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium">{item.workerName}</p>
                    <StatusBadge status={item.readiness} />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {item.approvedHoursLabel} · {item.grossLabel}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {item.wageSnapshotLabel} · OT {item.overtimeHoursLabel} informational
                  </p>
                </button>
              ))}
            </div>
          </>
        )}
        {workspace.availableWeeks.length > 0 && workspace.editable && workspace.runId ? (
          <AddWeekForm runId={workspace.runId} weeks={workspace.availableWeeks} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function PeriodForm({ workspace }: { workspace: PayrollWorkspaceData }) {
  const action = workspace.runId ? changePayrollPeriodAction : createPayrollRunAction;
  const [state, formAction, pending] = useActionState(action, initialState);
  return (
    <form id="create-payroll-run" action={formAction} className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:flex-wrap sm:items-end">
      {workspace.runId ? <input type="hidden" name="payrollRunId" value={workspace.runId} /> : null}
      <div className="min-w-0 flex-1">
        <Label htmlFor="payPeriodStart">Pay period start</Label>
        <Input
          id="payPeriodStart"
          name="payPeriodStart"
          type="date"
          defaultValue={workspace.periodStart}
          disabled={!workspace.editable}
        />
      </div>
      <div className="min-w-0 flex-1">
        <Label htmlFor="payPeriodEnd">Pay period end</Label>
        <Input
          id="payPeriodEnd"
          name="payPeriodEnd"
          type="date"
          defaultValue={workspace.periodEndInclusive}
          disabled={!workspace.editable}
        />
      </div>
      {workspace.editable ? (
        <Button type="submit" disabled={pending}>
          {workspace.runId ? "Update period" : "Create payroll run"}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">Period locked after authorization.</p>
      )}
      {state.error ? <p className="w-full text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="w-full text-sm text-emerald-400">{state.message}</p> : null}
    </form>
  );
}

function AddWeekForm({
  runId,
  weeks,
}: {
  runId: string;
  weeks: PayrollWorkspaceData["availableWeeks"];
}) {
  const [state, action, pending] = useActionState(addPayrollItemAction, initialState);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-dashed p-3 sm:flex-row sm:items-end">
      <input type="hidden" name="payrollRunId" value={runId} />
      <div className="min-w-0 flex-1">
        <Label htmlFor="timesheetWeekId">Add approved week</Label>
        <select
          id="timesheetWeekId"
          name="timesheetWeekId"
          className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
          defaultValue={weeks[0]?.timesheetWeekId}
        >
          {weeks.map((week) => (
            <option key={week.timesheetWeekId} value={week.timesheetWeekId}>
              {week.workerName} · {week.weekLabel} · {week.hoursLabel}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        Add
      </Button>
      {state.error ? <p className="w-full text-sm text-destructive">{state.error}</p> : null}
    </form>
  );
}

function ReadinessPanel({ workspace }: { workspace: PayrollWorkspaceData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Readiness / Funding</CardTitle>
        <CardDescription>Authorization is required before any provider could move money.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Status" value={workspace.statusLabel} />
          <Metric label="Workers" value={String(workspace.itemCount)} />
          <Metric label="Approved hours" value={workspace.approvedHoursTotal.toFixed(1)} />
          <Metric label="Est. gross" value={workspace.estimatedGrossLabel} />
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Needs attention</p>
          {workspace.attention.length === 0 ? (
            <p className="mt-1 text-muted-foreground">No outstanding payroll exceptions.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {workspace.attention.map((row) => (
                <li key={row.key} className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2">
                  <p className="font-medium text-amber-200">{row.label}</p>
                  <p className="text-xs text-amber-200/80">{row.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-dashed p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Funding check</p>
          <p className="mt-1">{workspace.fundingLabel}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Future: verified bank/provider balance, projected operating balance, sufficiency check. No invented balances.
          </p>
        </div>

        <div className="rounded-lg border border-dashed p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payroll Provider</p>
          <p className="mt-1">{workspace.providerLabel}</p>
          {workspace.processedSourceLabel ? (
            <p className="mt-1 text-xs">{workspace.processedSourceLabel}</p>
          ) : null}
          {workspace.providerReference ? (
            <p className="mt-1 text-xs text-muted-foreground">Reference: {workspace.providerReference}</p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            Authorized does not mean paid. No provider is connected.
          </p>
        </div>

        {workspace.canReview ? <ReviewForm runId={workspace.runId!} /> : null}
        {workspace.canAuthorize ? <AuthorizeForm workspace={workspace} /> : null}
        {workspace.canMarkProcessed ? <ProcessedForm runId={workspace.runId!} /> : null}
        {workspace.canReopen && workspace.runId ? <ReopenForm runId={workspace.runId} /> : null}
        {workspace.canCancel && workspace.runId ? <CancelForm runId={workspace.runId} /> : null}
        {!workspace.isOwner && workspace.status === "REVIEWED" ? (
          <p className="text-xs text-muted-foreground">Owner authorization is required before this run can proceed.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function WorkerDetail({ item, locked }: { item: PayrollReviewItem | null; locked: boolean }) {
  if (!item) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Worker Detail</CardTitle>
          <CardDescription>Select an included worker to see the approved time source.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{item.workerName}</CardTitle>
        <CardDescription>
          {item.workerRole} · week of {item.weekLabel}
          {!item.workerActive ? " · inactive worker, historical hours" : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Approved hours" value={item.approvedHoursLabel} />
          <Metric label="Regular hours" value={item.regularHoursLabel} />
          <Metric label="OT hours" value={`${item.overtimeHoursLabel} · informational`} />
          <Metric label="Wage snapshot" value={item.wageSnapshotLabel} />
          <Metric label="Gross labor" value={item.grossLabel} />
          <Metric label="Timesheet" value={item.timesheetStatusLabel} />
        </div>
        <p className="text-xs text-muted-foreground">
          OT pay rules not configured. Gross uses approved paid hours × approved hourly wage. Breaks are unpaid.
        </p>
        {item.exceptionLabels.length > 0 ? (
          <ul className="space-y-1">
            {item.exceptionLabels.map((label) => (
              <li key={label} className="text-amber-300">
                {label}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">No exceptions on this worker week.</p>
        )}
        <Button asChild variant="outline" size="sm">
          <Link href={item.timesheetHref}>Open approved timesheet</Link>
        </Button>
        {item.canRemove && !locked ? <RemoveItemForm itemId={item.id} /> : null}
      </CardContent>
    </Card>
  );
}

function PayrollHistory({
  history,
  currentRunId,
}: {
  history: PayrollWorkspaceData["history"];
  currentRunId: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payroll History</CardTitle>
        <CardDescription>Permanent records. Historical totals use the authorized snapshot, not current wages.</CardDescription>
      </CardHeader>
      <CardContent>
        {history.length === 0 ? (
          <EmptyState title="No payroll history yet" description="Create a run from approved Time Cards to start a record." />
        ) : (
          <ul className="space-y-2">
            {history.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/payroll?run=${row.id}`}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border px-3 py-3 sm:flex-row sm:items-center sm:justify-between",
                    currentRunId === row.id && "border-primary bg-primary/10",
                  )}
                >
                  <div className="min-w-0">
                    <p className="font-medium">{row.periodLabel}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.workerCount} worker{row.workerCount === 1 ? "" : "s"} · {row.approvedHoursLabel} · {row.grossLabel}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {row.authorizedAtLabel ? `Authorized ${row.authorizedAtLabel}` : "Not authorized"}
                      {row.processedAtLabel ? ` · Processed ${row.processedAtLabel}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={row.status} />
                    <span className="text-xs font-medium">Open</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ReviewForm({ runId }: { runId: string }) {
  const [state, action, pending] = useActionState(reviewPayrollRunAction, initialState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="payrollRunId" value={runId} />
      <Button type="submit" className="w-full" disabled={pending}>
        Mark reviewed
      </Button>
      <ActionMessage state={state} />
    </form>
  );
}

function AuthorizeForm({ workspace }: { workspace: PayrollWorkspaceData }) {
  const [state, action, pending] = useActionState(authorizePayrollRunAction, initialState);
  return (
    <form action={action} className="space-y-2 rounded-lg border border-primary/40 p-3">
      <input type="hidden" name="payrollRunId" value={workspace.runId ?? ""} />
      <p className="text-xs font-semibold uppercase tracking-wide">Authorize payroll</p>
      <ul className="text-xs text-muted-foreground">
        <li>Period: {workspace.periodLabel}</li>
        <li>Workers: {workspace.itemCount}</li>
        <li>Approved hours: {workspace.approvedHoursTotal.toFixed(1)}</li>
        <li>Estimated gross payroll: {workspace.estimatedGrossLabel}</li>
        <li>Warnings: {workspace.needsAttentionCount}</li>
      </ul>
      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" name="confirmAuthorize" value="yes" className="mt-0.5" required />
        I confirm this authorization. TBBT will not send this to a provider or move funds.
      </label>
      <Button type="submit" className="w-full" disabled={pending}>
        Authorize payroll
      </Button>
      <ActionMessage state={state} />
    </form>
  );
}

function ProcessedForm({ runId }: { runId: string }) {
  const [state, action, pending] = useActionState(markPayrollProcessedAction, initialState);
  return (
    <form action={action} className="space-y-2 rounded-lg border p-3">
      <input type="hidden" name="payrollRunId" value={runId} />
      <p className="text-xs font-semibold uppercase tracking-wide">Processed externally</p>
      <p className="text-xs text-muted-foreground">Record that payroll was completed outside TBBT. This does not move funds.</p>
      <Label htmlFor="providerReference">Provider / reference (optional)</Label>
      <Input id="providerReference" name="providerReference" />
      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" name="confirmProcessed" value="yes" className="mt-0.5" required />
        Record this run as processed externally / recorded manually.
      </label>
      <Button type="submit" variant="outline" className="w-full" disabled={pending}>
        Mark processed externally
      </Button>
      <ActionMessage state={state} />
    </form>
  );
}

function ReopenForm({ runId }: { runId: string }) {
  const [state, action, pending] = useActionState(reopenPayrollRunAction, initialState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="payrollRunId" value={runId} />
      <Label htmlFor="reopenReason">Reopen / correction reason</Label>
      <Input id="reopenReason" name="reason" required />
      <Button type="submit" variant="outline" className="w-full" disabled={pending}>
        Reopen payroll run
      </Button>
      <ActionMessage state={state} />
    </form>
  );
}

function CancelForm({ runId }: { runId: string }) {
  const [state, action, pending] = useActionState(cancelPayrollRunAction, initialState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="payrollRunId" value={runId} />
      <Label htmlFor="cancelReason">Cancel reason</Label>
      <Input id="cancelReason" name="reason" required />
      <Button type="submit" variant="outline" className="w-full" disabled={pending}>
        Cancel payroll run
      </Button>
      <ActionMessage state={state} />
    </form>
  );
}

function RemoveItemForm({ itemId }: { itemId: string }) {
  const [state, action, pending] = useActionState(removePayrollItemAction, initialState);
  return (
    <form action={action}>
      <input type="hidden" name="payrollRunItemId" value={itemId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        Remove from this run
      </Button>
      <ActionMessage state={state} />
    </form>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-medium break-words">{value}</p>
    </div>
  );
}

function ActionMessage({ state }: { state: PayrollActionState }) {
  if (state.error) return <p className="text-sm text-destructive">{state.error}</p>;
  if (state.message) return <p className="text-sm text-emerald-400">{state.message}</p>;
  return null;
}

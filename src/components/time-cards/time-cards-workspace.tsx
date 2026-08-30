"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import {
  approveTimesheetWeekAction,
  correctTimeEntryAction,
  reopenTimesheetWeekAction,
  updateMembershipWageAction,
  type TimeCardActionState,
} from "@/app/actions/time-cards";
import { AddTimeEntrySheet } from "@/components/time-cards/add-time-entry-sheet";
import type {
  TimeCardAdjustment,
  TimeCardEntry,
  TimeCardJobOption,
  TimeCardView,
  TimeCardWorker,
} from "@/components/time-cards/types";
import { EmptyState } from "@/components/empty-state";
import { FounderRegion } from "@/components/founder-design/region";
import { PageHeaderControls } from "@/components/page-header-controls";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatDurationClock, TIME_ACTIVITY_LABELS, TIME_ACTIVITY_TYPES, TIME_STATUS_LABELS } from "@/lib/time-cards";
import { cn } from "@/lib/utils";

const VIEWS: { id: TimeCardView; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "timesheets", label: "Timesheets" },
  { id: "approvals", label: "Approvals" },
  { id: "crew", label: "Crew" },
];

const initialState: TimeCardActionState = {};

export function TimeCardsWorkspace({
  view,
  date,
  weekStartedAt,
  weekLabel,
  workers,
  jobs,
  entries,
  adjustments,
  selectedMembershipId,
  payrollReadyCount,
  weekWorkerCount,
}: {
  view: TimeCardView;
  date: string;
  weekStartedAt: string;
  weekLabel: string;
  workers: TimeCardWorker[];
  jobs: TimeCardJobOption[];
  entries: TimeCardEntry[];
  adjustments: TimeCardAdjustment[];
  selectedMembershipId: string | null;
  payrollReadyCount: number;
  weekWorkerCount: number;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(
    selectedMembershipId ?? workers[0]?.membershipId ?? null,
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [workerFilter, setWorkerFilter] = useState("all");
  const [jobFilter, setJobFilter] = useState("all");

  const selected = workers.find((worker) => worker.membershipId === selectedId) ?? null;
  const selectedEntries = entries.filter((entry) => entry.membershipId === selectedId);
  const selectedAdjustments = adjustments.filter((item) =>
    selectedEntries.some((entry) => entry.id === item.timeEntryId),
  );

  const todayEntries = useMemo(() => {
    return entries.filter((entry) => {
      const day = entry.startDate;
      if (day !== date) return false;
      if (workerFilter !== "all" && entry.membershipId !== workerFilter) return false;
      if (jobFilter !== "all" && entry.jobId !== jobFilter) return false;
      return true;
    });
  }, [entries, date, workerFilter, jobFilter]);

  function selectWorker(id: string) {
    setSelectedId(id);
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1279px)").matches) {
      setMobileOpen(true);
    }
  }

  const hrefFor = (next: Partial<{ view: string; date: string; week: string; worker: string }>) => {
    const params = new URLSearchParams();
    params.set("view", next.view ?? view);
    params.set("date", next.date ?? date);
    params.set("week", next.week ?? weekStartedAt.slice(0, 10));
    if (next.worker ?? selectedId) params.set("worker", next.worker ?? selectedId ?? "");
    return `/time-cards?${params.toString()}`;
  };

  return (
    <>
      <PageHeaderControls
        title="Time Cards"
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
              + Time Entry
            </Button>
            <Button size="sm" asChild>
              <Link href={hrefFor({ view: "approvals" })}>
                {payrollReadyCount} of {weekWorkerCount} Approved → Payroll
              </Link>
            </Button>
          </div>
        }
      />

      <FounderRegion id="tabs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-1.5">
            {VIEWS.map((item) => (
              <Link
                key={item.id}
                href={hrefFor({ view: item.id })}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-semibold tracking-wide uppercase",
                  view === item.id
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            ))}
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            <select
              value={workerFilter}
              onChange={(event) => setWorkerFilter(event.target.value)}
              className={filterClass}
            >
              <option value="all">All workers</option>
              {workers.map((worker) => (
                <option key={worker.membershipId} value={worker.membershipId}>
                  {worker.name}
                </option>
              ))}
            </select>
            <select value={jobFilter} onChange={(event) => setJobFilter(event.target.value)} className={filterClass}>
              <option value="all">All jobs</option>
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.label}
                </option>
              ))}
            </select>
            <input
              type="date"
              defaultValue={date}
              className={filterClass}
              onChange={(event) => {
                window.location.href = hrefFor({ date: event.target.value });
              }}
            />
          </div>
        </div>
      </FounderRegion>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,320px)]">
        <FounderRegion id="table" className="min-w-0">
          {view === "today" ? (
            <TodayTable
              entries={todayEntries}
              selectedId={selectedId}
              onSelect={selectWorker}
            />
          ) : null}
          {view === "timesheets" ? (
            <TimesheetsView
              workers={workers}
              selected={selected}
              entries={selectedEntries}
              weekLabel={weekLabel}
              onSelect={selectWorker}
            />
          ) : null}
          {view === "approvals" ? (
            <ApprovalsView workers={workers} entries={entries} onSelect={selectWorker} selectedId={selectedId} />
          ) : null}
          {view === "crew" ? (
            <CrewView workers={workers} entries={entries} onSelect={selectWorker} selectedId={selectedId} />
          ) : null}
        </FounderRegion>

        <FounderRegion id="details" className="hidden min-w-0 xl:block">
          <WorkerDetailPanel
            worker={selected}
            entries={selectedEntries}
            adjustments={selectedAdjustments}
            jobs={jobs}
            weekStartedAt={weekStartedAt}
            weekLabel={weekLabel}
          />
        </FounderRegion>
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto xl:hidden">
          <SheetHeader>
            <SheetTitle>{selected?.name ?? "Worker"}</SheetTitle>
          </SheetHeader>
          <div className="px-1 pb-6">
            <WorkerDetailPanel
              worker={selected}
              entries={selectedEntries}
              adjustments={selectedAdjustments}
              jobs={jobs}
              weekStartedAt={weekStartedAt}
              weekLabel={weekLabel}
            />
          </div>
        </SheetContent>
      </Sheet>

      <AddTimeEntrySheet
        open={addOpen}
        onOpenChange={setAddOpen}
        workers={workers}
        jobs={jobs}
        defaultMembershipId={selectedId ?? workers[0]?.membershipId ?? ""}
        defaultDate={date}
      />
    </>
  );
}

function TodayTable({
  entries,
  selectedId,
  onSelect,
}: {
  entries: TimeCardEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const todayHours = entries.reduce((sum, entry) => sum + entry.totalHours, 0);
  const billable = entries
    .filter((entry) => entry.activityType === "JOB" && entry.jobId)
    .reduce((sum, entry) => sum + entry.totalHours, 0);
  const nonBillable = Math.round((todayHours - billable) * 100) / 100;

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No time entries today"
        description="Clock in from the field, or add a manual entry."
      />
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="hidden min-w-0 sm:block">
        <table className="w-full" style={{ fontSize: "var(--tbbt-table-font-size, 14px)" }}>
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              {["Worker", "Job / Activity", "Clock", "Total", "Status"].map((header) => (
                <th
                  key={header}
                  className="font-medium"
                  style={{
                    padding: "var(--tbbt-table-header-py, 14px) var(--tbbt-table-cell-px, 8px)",
                    fontSize: "var(--tbbt-table-header-font-size, 12px)",
                  }}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.id}
                tabIndex={0}
                onClick={() => onSelect(entry.membershipId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onSelect(entry.membershipId);
                }}
                className={cn(
                  "cursor-pointer border-b last:border-0",
                  selectedId === entry.membershipId ? "bg-primary/10" : "hover:bg-muted/40",
                )}
              >
                <td style={{ padding: "var(--tbbt-table-row-py, 16px) var(--tbbt-table-cell-px, 8px)" }}>
                  <p className="font-medium">{entry.workerName}</p>
                  <p className="text-xs text-muted-foreground">{entry.workerRole}</p>
                </td>
                <td style={{ padding: "var(--tbbt-table-row-py, 16px) var(--tbbt-table-cell-px, 8px)" }}>
                  <p>{entry.jobLabel ?? entry.activityLabel}</p>
                  {entry.jobLabel ? (
                    <p className="text-xs text-muted-foreground">{entry.activityLabel}</p>
                  ) : null}
                </td>
                <td style={{ padding: "var(--tbbt-table-row-py, 16px) var(--tbbt-table-cell-px, 8px)" }}>
                  {entry.clockLabel}
                </td>
                <td style={{ padding: "var(--tbbt-table-row-py, 16px) var(--tbbt-table-cell-px, 8px)" }}>
                  {entry.totalLabel}
                </td>
                <td style={{ padding: "var(--tbbt-table-row-py, 16px) var(--tbbt-table-cell-px, 8px)" }}>
                  <StatusBadge status={entry.status} />
                  <span className="sr-only">{TIME_STATUS_LABELS[entry.status as keyof typeof TIME_STATUS_LABELS]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-2 p-3 sm:hidden">
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onSelect(entry.membershipId)}
            className={cn(
              "w-full rounded-lg border p-3 text-left",
              selectedId === entry.membershipId ? "border-primary bg-primary/10" : "border-border",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{entry.workerName}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {entry.jobLabel ?? entry.activityLabel}
                </p>
                <p className="text-xs text-muted-foreground">{entry.clockLabel}</p>
              </div>
              <div className="text-right">
                <p className="font-semibold">{entry.totalLabel}</p>
                <StatusBadge status={entry.status} />
              </div>
            </div>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-4 border-t px-4 py-3 text-xs font-semibold tracking-wide uppercase text-muted-foreground">
        <span>Today: {formatDurationClock(todayHours)} hrs</span>
        <span>Billable: {formatDurationClock(billable)} hrs</span>
        <span>Non-billable: {formatDurationClock(nonBillable)} hrs</span>
      </div>
    </Card>
  );
}

function TimesheetsView({
  workers,
  selected,
  entries,
  weekLabel,
  onSelect,
}: {
  workers: TimeCardWorker[];
  selected: TimeCardWorker | null;
  entries: TimeCardEntry[];
  weekLabel: string;
  onSelect: (id: string) => void;
}) {
  const byDay = new Map<string, TimeCardEntry[]>();
  for (const entry of entries) {
    const list = byDay.get(entry.startDate) ?? [];
    list.push(entry);
    byDay.set(entry.startDate, list);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Weekly timesheet</CardTitle>
        <CardDescription>
          {selected ? `${selected.name} · ${weekLabel}` : "Choose a worker"}
        </CardDescription>
        <select
          value={selected?.membershipId ?? ""}
          onChange={(event) => onSelect(event.target.value)}
          className={filterClass}
        >
          {workers.map((worker) => (
            <option key={worker.membershipId} value={worker.membershipId}>
              {worker.name}
            </option>
          ))}
        </select>
      </CardHeader>
      <CardContent className="space-y-4">
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entries this week.</p>
        ) : (
          [...byDay.entries()].map(([day, dayEntries]) => (
            <div key={day} className="space-y-2">
              <p className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">{day}</p>
              {dayEntries.map((entry) => (
                <div key={entry.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate">{entry.jobLabel ?? entry.activityLabel}</p>
                    <p className="text-xs text-muted-foreground">{entry.clockLabel}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-medium">{entry.totalLabel}</p>
                    <StatusBadge status={entry.status} />
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function ApprovalsView({
  workers,
  entries,
  onSelect,
  selectedId,
}: {
  workers: TimeCardWorker[];
  entries: TimeCardEntry[];
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Approval queue</CardTitle>
        <CardDescription>Approve a week only when every clock is stopped.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {workers.map((worker) => {
          const workerEntries = entries.filter((entry) => entry.membershipId === worker.membershipId);
          const hours = workerEntries.reduce((sum, entry) => sum + entry.totalHours, 0);
          const exceptions = workerEntries.filter((entry) => entry.status === "NEEDS_REVIEW").length;
          const running = workerEntries.some((entry) => entry.status === "RUNNING");
          const ready = !running && workerEntries.length > 0 && worker.weekStatus !== "APPROVED";
          return (
            <button
              key={worker.membershipId}
              type="button"
              onClick={() => onSelect(worker.membershipId)}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left",
                selectedId === worker.membershipId ? "border-primary bg-primary/10" : "border-border",
              )}
            >
              <div className="min-w-0">
                <p className="font-medium">{worker.name}</p>
                <p className="text-xs text-muted-foreground">
                  {exceptions} exception{exceptions === 1 ? "" : "s"}
                  {running ? " · clock still running" : ready ? " · ready to approve" : ""}
                </p>
              </div>
              <div className="text-right text-sm">
                <p className="font-semibold">{formatDurationClock(hours)}</p>
                <p className={worker.payrollReady ? "text-emerald-400" : "text-muted-foreground"}>
                  {worker.payrollReady ? "Payroll Ready" : worker.weekStatus}
                </p>
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}

function CrewView({
  workers,
  entries,
  onSelect,
  selectedId,
}: {
  workers: TimeCardWorker[];
  entries: TimeCardEntry[];
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  const active = workers.filter((worker) => worker.active);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Crew</CardTitle>
        <CardDescription>Active workers and their current clock state.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {active.map((worker) => {
          const hours = entries
            .filter((entry) => entry.membershipId === worker.membershipId)
            .reduce((sum, entry) => sum + entry.totalHours, 0);
          return (
            <button
              key={worker.membershipId}
              type="button"
              onClick={() => onSelect(worker.membershipId)}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left",
                selectedId === worker.membershipId ? "border-primary bg-primary/10" : "border-border",
              )}
            >
              <div className="min-w-0">
                <p className="font-medium">{worker.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {worker.clockedIn
                    ? `Working · ${worker.currentActivityLabel ?? "Clocked in"}`
                    : "Not clocked in"}
                </p>
              </div>
              <div className="text-right text-sm">
                <p className="font-semibold">{formatDurationClock(hours)}</p>
                <p className={worker.payrollReady ? "text-emerald-400" : "text-muted-foreground"}>
                  {worker.payrollReady ? "Payroll Ready" : "Open"}
                </p>
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}

function WorkerDetailPanel({
  worker,
  entries,
  adjustments,
  jobs,
  weekStartedAt,
  weekLabel,
}: {
  worker: TimeCardWorker | null;
  entries: TimeCardEntry[];
  adjustments: TimeCardAdjustment[];
  jobs: TimeCardJobOption[];
  weekStartedAt: string;
  weekLabel: string;
}) {
  if (!worker) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Worker</CardTitle>
          <CardDescription>Select a worker to review their day and week.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const dayHours = entries
    .filter((entry) => entry.startDate === new Date().toISOString().slice(0, 10) || entry.status === "RUNNING")
    .reduce((sum, entry) => sum + entry.totalHours, 0);
  const weekHours = entries.reduce((sum, entry) => sum + entry.totalHours, 0);
  const breaks = entries
    .filter((entry) => entry.activityType === "BREAK")
    .reduce((sum, entry) => sum + entry.totalHours, 0);
  const wage = worker.hourlyWageInput ? Number(worker.hourlyWageInput) : null;
  const weekCost = wage != null ? Math.round(weekHours * wage * 100) / 100 : null;
  const dayCost = wage != null ? Math.round(dayHours * wage * 100) / 100 : null;
  const ot = Math.max(0, Math.round((weekHours - 40) * 100) / 100);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{worker.name}</CardTitle>
        <CardDescription>
          {worker.role} · {weekLabel}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <WageForm key={worker.membershipId} worker={worker} />

        <div className="grid grid-cols-2 gap-2 text-sm">
          <Metric label="Week hours" value={weekHours.toFixed(1)} />
          <Metric
            label="Gross estimate"
            value={weekCost != null ? `$${weekCost.toFixed(2)}` : "—"}
          />
          <Metric label="OT hours" value={ot.toFixed(1)} />
          <Metric label="Day hours" value={dayHours.toFixed(1)} />
          <Metric label="Day cost" value={dayCost != null ? `$${dayCost.toFixed(2)}` : "—"} />
          <Metric label="Breaks" value={breaks.toFixed(1)} />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-semibold">{worker.name.split(" ")[0]}’s day</p>
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No entries this week.</p>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} className="rounded-lg border px-3 py-2 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate">{entry.jobLabel ?? entry.activityLabel}</p>
                    <p className="text-xs text-muted-foreground">{entry.clockLabel}</p>
                  </div>
                  <StatusBadge status={entry.status} />
                </div>
                {entry.canEdit ? <CorrectEntryForm entry={entry} jobs={jobs} /> : null}
              </div>
            ))
          )}
        </div>

        {adjustments.length > 0 ? (
          <div className="space-y-1">
            <p className="text-sm font-semibold">Audit trail</p>
            {adjustments.map((item) => (
              <p key={item.id} className="text-xs text-muted-foreground">
                {item.createdAtLabel} · {item.actorName} · {item.action}
                {item.reason ? ` — ${item.reason}` : ""}
              </p>
            ))}
          </div>
        ) : null}

        {weekCost != null ? (
          <p className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
            Weekly labor estimate: {weekHours.toFixed(1)} hrs × {worker.hourlyWageLabel} = $
            {weekCost.toFixed(2)} gross
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Set an hourly wage to estimate labor cost. This is a gross estimate, not net pay.
          </p>
        )}

        {worker.payrollReady ? (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-emerald-400">Payroll Ready</p>
            <ReopenForm
              key={`reopen-${worker.membershipId}-${weekStartedAt}`}
              membershipId={worker.membershipId}
              weekStartedAt={weekStartedAt}
            />
          </div>
        ) : (
          <ApproveForm
            key={`approve-${worker.membershipId}-${weekStartedAt}`}
            membershipId={worker.membershipId}
            weekStartedAt={weekStartedAt}
            name={worker.name}
          />
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border px-2.5 py-2">
      <p className="text-[10px] font-semibold tracking-wide uppercase text-muted-foreground">{label}</p>
      <p className="text-base font-semibold">{value}</p>
    </div>
  );
}

function WageForm({ worker }: { worker: TimeCardWorker }) {
  const [state, action, pending] = useActionState(updateMembershipWageAction, initialState);
  return (
    <form action={action} className="space-y-2 rounded-lg border px-3 py-3">
      <input type="hidden" name="membershipId" value={worker.membershipId} />
      <Label>Hourly wage</Label>
      <div className="flex gap-2">
        <Input
          name="hourlyWage"
          defaultValue={worker.hourlyWageInput}
          placeholder="25.00"
          inputMode="decimal"
        />
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Edit"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {worker.hourlyWageLabel ?? "No wage on file"} · owner/admin only · gross estimate, not payroll
      </p>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
    </form>
  );
}

function ApproveForm({
  membershipId,
  weekStartedAt,
  name,
}: {
  membershipId: string;
  weekStartedAt: string;
  name: string;
}) {
  const [state, action, pending] = useActionState(approveTimesheetWeekAction, initialState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="membershipId" value={membershipId} />
      <input type="hidden" name="weekStartedAt" value={weekStartedAt} />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Approving…" : `Approve ${name.split(" ")[0]}’s Week`}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        After approval: {name.split(" ")[0]} → Payroll Ready
      </p>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
    </form>
  );
}

function ReopenForm({
  membershipId,
  weekStartedAt,
}: {
  membershipId: string;
  weekStartedAt: string;
}) {
  const [state, action, pending] = useActionState(reopenTimesheetWeekAction, initialState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="membershipId" value={membershipId} />
      <input type="hidden" name="weekStartedAt" value={weekStartedAt} />
      <Input name="reason" placeholder="Reason to reopen" required />
      <Button type="submit" variant="outline" disabled={pending} className="w-full">
        {pending ? "Reopening…" : "Reopen week"}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
    </form>
  );
}

function CorrectEntryForm({ entry, jobs }: { entry: TimeCardEntry; jobs: TimeCardJobOption[] }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(correctTimeEntryAction, initialState);
  if (!open) {
    return (
      <button type="button" className="mt-1 text-xs text-primary" onClick={() => setOpen(true)}>
        Correct
      </button>
    );
  }
  return (
    <form action={action} className="mt-2 space-y-2 border-t pt-2">
      <input type="hidden" name="timeEntryId" value={entry.id} />
      <select name="activityType" defaultValue={entry.activityType} className={filterClass}>
        {TIME_ACTIVITY_TYPES.map((type) => (
          <option key={type} value={type}>
            {TIME_ACTIVITY_LABELS[type]}
          </option>
        ))}
      </select>
      <select name="jobId" defaultValue={entry.jobId ?? ""} className={filterClass}>
        <option value="">No job</option>
        {jobs.map((job) => (
          <option key={job.id} value={job.id}>
            {job.label}
          </option>
        ))}
      </select>
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" name="startDate" defaultValue={entry.startDate} />
        <Input type="time" name="startTime" defaultValue={entry.startTime} />
        <Input type="date" name="endDate" defaultValue={entry.endDate || entry.startDate} />
        <Input type="time" name="endTime" defaultValue={entry.endTime || ""} />
      </div>
      <Input name="reason" placeholder="Reason for correction" required />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save correction"}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
    </form>
  );
}

const filterClass =
  "h-8 min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-xs dark:bg-input/30";

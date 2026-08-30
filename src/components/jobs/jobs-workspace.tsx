"use client";

import { useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { Camera, ExternalLink, FileText, Mail, MapPin, Phone, Receipt, UserCog } from "lucide-react";
import { AssignJobMemberForm, type EligibleMember } from "@/components/jobs/assign-job-member-form";
import { CopyProjectLinkButton } from "@/components/jobs/copy-project-link-button";
import { MarkJobCompleteButton } from "@/components/jobs/mark-job-complete-button";
import { ScheduleJobForm } from "@/components/jobs/schedule-job-form";
import { StartJobButton } from "@/components/jobs/start-job-button";
import { CreateInvoiceButton } from "@/components/invoices/create-invoice-button";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { telHref } from "@/lib/directions";
import { cn } from "@/lib/utils";

export type JobChangeOrderSummary = {
  id: string;
  title: string;
  totalLabel: string;
};

export type JobLineItemSummary = {
  description: string;
  quantity: string;
  unitPrice: string;
  total: string;
};

export type JobListItem = {
  id: string;
  status: string;
  customer: { id: string; name: string; phone: string | null; email: string | null } | null;
  propertyLabel: string | null;
  scopeSummary: string | null;
  scheduledAtLabel: string | null;
  durationLabel: string | null;
  assignedMemberName: string | null;
  assignedMembershipId: string | null;
  amountLabel: string | null;
  invoice: { id: string; status: string; totalLabel: string } | null;
  projectToken: string;
  photoCount: number;
  additionalWorkRequestCount: number;
  // Schedule form defaults (see toDateInput/toTimeInput on the Work Order page).
  scheduleDate: string;
  scheduleTime: string;
  durationPreset: string;
  customHours: string;
  // Approved scope, read-only display.
  approvedScopeSource: "version" | "legacy-estimate" | "none";
  approvedScopeVersionNumber: number | null;
  originalApprovedTotalLabel: string | null;
  approvedScopeLineItems: JobLineItemSummary[];
  approvedChangeOrders: JobChangeOrderSummary[];
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/**
 * The Jobs master/detail workspace, added BELOW the existing, unchanged
 * Month/Week/Day/Crew calendar section (passed in as `calendarSection` --
 * see src/app/(app)/jobs/page.tsx). Mirrors the exact pattern already
 * approved on Requests/Estimates: a dense table (desktop) or stacked card
 * list (mobile), plus a Job Details panel (right on desktop, a bottom
 * sheet on mobile). Every mutation button here (Start/Complete Job,
 * Schedule/Reschedule, Assign, Create Invoice, Copy project link) is the
 * SAME real, already-tested server action used on the full Work Order page
 * -- nothing here reimplements or bypasses that lifecycle. Selecting a
 * calendar Job pill/row still navigates directly to the real Work Order
 * page, unchanged; this workspace's own table is the new master-detail
 * surface with in-place selection.
 */
export function JobsWorkspace({
  calendarSection,
  jobs,
  eligibleMembers,
  pagination,
}: {
  calendarSection: ReactNode;
  jobs: JobListItem[];
  eligibleMembers: EligibleMember[];
  pagination: ReactNode;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(jobs[0]?.id ?? null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const selected = jobs.find((job) => job.id === selectedId) ?? null;

  function selectJob(id: string) {
    setSelectedId(id);
    // Only open the bottom sheet below the `lg` breakpoint where the
    // desktop Details panel (rendered separately, see below) is hidden.
    // Sheet's overlay covers the full viewport and intercepts pointer
    // events on the table beneath it regardless of whether its content
    // is itself hidden by a `lg:hidden`/`xl:hidden` class, so this must
    // never open on desktop -- otherwise every row after the first
    // becomes unclickable (the exact bug found and fixed on Estimates).
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1279px)").matches) {
      setMobileOpen(true);
    }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,350px)]">
      <div className="space-y-4">
        {calendarSection}

        {jobs.length === 0 ? (
          <EmptyState
            title="No jobs match your filters"
            description="Try a different status, crew member, date range, or search term."
          />
        ) : (
          <>
            <div className="hidden sm:block">
              <JobsTable jobs={jobs} selectedId={selectedId} onSelect={selectJob} />
            </div>
            <div className="space-y-2 sm:hidden">
              <JobsMobileList jobs={jobs} selectedId={selectedId} onSelect={selectJob} />
            </div>
            {pagination}
          </>
        )}
      </div>

      <div className="hidden xl:block">
        <JobDetailsPanel job={selected} eligibleMembers={eligibleMembers} />
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto xl:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>Job details</SheetTitle>
          </SheetHeader>
          <JobDetailsPanel job={selected} eligibleMembers={eligibleMembers} />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function JobsTable({
  jobs,
  selectedId,
  onSelect,
}: {
  jobs: JobListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card className="overflow-hidden border-border/70 p-0 shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full" style={{ fontSize: "var(--tbbt-table-font-size, 14px)" }}>
          <thead>
            <tr
              className="border-b border-border/70 bg-muted/50 text-left font-semibold tracking-wide text-muted-foreground uppercase"
              style={
                {
                  "--th-py": "var(--tbbt-table-header-py, 14px)",
                  "--cell-px": "var(--tbbt-table-cell-px, 8px)",
                  fontSize: "var(--tbbt-table-header-font-size, 12px)",
                } as CSSProperties
              }
            >
              <th className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Job / Customer</th>
              <th className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Service / Scope</th>
              <th className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Date &amp; Time</th>
              <th className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Status</th>
              <th className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Crew / Assignee</th>
              <th className="text-right font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Amount</th>
              <th className="text-right font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const active = job.id === selectedId;
              return (
                <tr
                  key={job.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(job.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(job.id);
                    }
                  }}
                  className={cn(
                    "cursor-pointer border-b border-border/60 outline-none transition-colors last:border-b-0 hover:bg-accent/40",
                    active && "bg-primary/10 hover:bg-primary/10",
                  )}
                  style={
                    {
                      "--tr-py": "var(--tbbt-table-row-py, 16px)",
                      "--cell-px": "var(--tbbt-table-cell-px, 8px)",
                    } as CSSProperties
                  }
                >
                  <td
                    className={cn("max-w-24 align-top", active && "border-l-2 border-l-primary")}
                    style={{ padding: "var(--tr-py) var(--cell-px)" }}
                  >
                    <p className="truncate font-semibold text-foreground" style={{ fontSize: "1.09em" }}>
                      {job.customer?.name ?? "Customer"}
                    </p>
                    {job.propertyLabel ? (
                      <p className="truncate text-xs text-muted-foreground">{job.propertyLabel}</p>
                    ) : null}
                  </td>
                  <td className="max-w-28 align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                    <p className="truncate font-medium text-foreground" style={{ fontSize: "1.09em" }}>
                      {job.scopeSummary ?? "—"}
                    </p>
                  </td>
                  <td
                    className="align-top text-muted-foreground whitespace-nowrap"
                    style={{ padding: "var(--tr-py) var(--cell-px)" }}
                  >
                    {job.scheduledAtLabel ?? "Unscheduled"}
                    {job.durationLabel ? (
                      <p className="text-xs text-muted-foreground">{job.durationLabel}</p>
                    ) : null}
                  </td>
                  <td className="align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                    <StatusBadge status={job.status} />
                  </td>
                  <td className="max-w-20 align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                    <p className="truncate text-foreground">{job.assignedMemberName ?? "Unassigned"}</p>
                  </td>
                  <td
                    className="text-right align-top tabular-nums font-semibold text-foreground whitespace-nowrap"
                    style={{ padding: "var(--tr-py) var(--cell-px)" }}
                  >
                    {job.amountLabel ?? "—"}
                  </td>
                  <td
                    className="text-right align-top"
                    style={{ padding: "var(--tr-py) var(--cell-px)" }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/jobs/${job.id}`}>Open</Link>
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function JobsMobileList({
  jobs,
  selectedId,
  onSelect,
}: {
  jobs: JobListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {jobs.map((job) => {
        const active = job.id === selectedId;
        return (
          <button
            key={job.id}
            type="button"
            onClick={() => onSelect(job.id)}
            className={cn(
              "block w-full rounded-xl border p-3.5 text-left transition-colors active:bg-accent/60",
              active ? "border-primary/40 bg-accent/40" : "border-border/70 bg-card/40",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{job.customer?.name ?? "Customer"}</p>
                <p className="truncate text-xs text-muted-foreground">{job.scopeSummary ?? "—"}</p>
              </div>
              <StatusBadge status={job.status} />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{job.scheduledAtLabel ?? "Unscheduled"}</span>
              <span className="text-sm font-semibold text-foreground">{job.amountLabel ?? "—"}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {job.assignedMemberName ?? "Unassigned"}
            </p>
          </button>
        );
      })}
    </>
  );
}

function DetailField({
  icon: Icon,
  label,
  children,
}: {
  icon?: ComponentType<{ className?: string }>;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {Icon ? <Icon className="size-3.5" /> : null}
        {label}
      </p>
      <div className="text-[0.95rem] text-foreground">{children}</div>
    </div>
  );
}

function JobDetailsPanel({
  job,
  eligibleMembers,
}: {
  job: JobListItem | null;
  eligibleMembers: EligibleMember[];
}) {
  if (!job) {
    return (
      <Card className="flex h-full min-h-64 items-center justify-center border-border/70 p-8 text-center">
        <p className="text-sm text-muted-foreground">Select a job to see its details.</p>
      </Card>
    );
  }

  const tel = telHref(job.customer?.phone ?? null);
  const mailto = job.customer?.email ? `mailto:${job.customer.email}` : null;
  const customerName = job.customer?.name ?? "Customer";
  const isCompleted = job.status === "COMPLETED";
  const isInProgress = job.status === "IN_PROGRESS";
  const isScheduled = Boolean(job.scheduledAtLabel);

  return (
    <Card className="flex h-full flex-col border-border/70 shadow-sm">
      <CardHeader className="border-b border-border/60 pb-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Avatar size="lg" className="ring-2 ring-primary/15">
              <AvatarFallback className="bg-primary/15 text-base font-semibold text-primary">
                {initials(customerName)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <CardTitle className="text-xl">{customerName}</CardTitle>
              <CardDescription className="font-mono">#{job.id.slice(-8)}</CardDescription>
            </div>
          </div>
          <StatusBadge status={job.status} />
        </div>
      </CardHeader>
      <CardContent className="flex-1 space-y-6 overflow-y-auto pt-5">
        <DetailField icon={Phone} label="Contact">
          <p>{job.customer?.phone || "No phone on file"}</p>
          <p>{job.customer?.email || "No email on file"}</p>
        </DetailField>

        <DetailField icon={MapPin} label="Service address">
          {job.propertyLabel ?? "None on file"}
        </DetailField>

        <DetailField icon={FileText} label="Scope">
          {job.scopeSummary ?? "No approved estimate is linked to this job yet."}
        </DetailField>

        <div className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-3">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {isCompleted || isScheduled ? "Appointment" : "Schedule Job"}
          </p>
          {isCompleted ? (
            <p className="text-sm text-muted-foreground">
              Completed jobs keep their saved appointment and cannot be rescheduled.
            </p>
          ) : (
            <ScheduleJobForm
              jobId={job.id}
              date={job.scheduleDate}
              time={job.scheduleTime}
              durationPreset={job.durationPreset}
              customHours={job.customHours}
              isScheduled={isScheduled}
            />
          )}
        </div>

        <div className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <UserCog className="size-3.5" />
            Assigned Employee
          </p>
          {eligibleMembers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No team members yet. Invite a MEMBER to assign jobs.
            </p>
          ) : (
            <AssignJobMemberForm
              jobId={job.id}
              assignedMembershipId={job.assignedMembershipId}
              eligibleMembers={eligibleMembers}
            />
          )}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Original Approved Scope
          </p>
          {job.approvedScopeSource === "none" ? (
            <p className="text-sm text-muted-foreground">No approved estimate is linked to this job yet.</p>
          ) : (
            <>
              <ul className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-3 text-sm">
                {job.approvedScopeLineItems.map((item, index) => (
                  <li key={index} className="flex items-start justify-between gap-3">
                    <span className="min-w-0 flex-1 break-words text-foreground">
                      {item.description} × {item.quantity}
                    </span>
                    <span className="shrink-0 font-medium tabular-nums text-foreground">{item.total}</span>
                  </li>
                ))}
              </ul>
              <div className="space-y-1 text-sm">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Original Approved Total</span>
                  <span className="tabular-nums">{job.originalApprovedTotalLabel}</span>
                </div>
                {job.approvedChangeOrders.length > 0 ? (
                  <div className="space-y-1">
                    <p className="text-muted-foreground">Approved Change Orders</p>
                    {job.approvedChangeOrders.map((co) => (
                      <div key={co.id} className="flex items-center justify-between pl-2 text-muted-foreground">
                        <span className="truncate">{co.title}</span>
                        <span className="tabular-nums">{co.totalLabel}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="flex items-center justify-between border-t border-border/60 pt-2 text-base font-semibold text-foreground">
                  <span>Current Approved Project Total</span>
                  <span className="tabular-nums">{job.amountLabel}</span>
                </div>
              </div>
            </>
          )}
        </div>

        {job.additionalWorkRequestCount > 0 ? (
          <DetailField icon={Receipt} label="Additional Work Requests">
            {job.additionalWorkRequestCount} open request
            {job.additionalWorkRequestCount === 1 ? "" : "s"} — review on the full Work Order.
          </DetailField>
        ) : null}

        {job.photoCount > 0 ? (
          <DetailField icon={Camera} label="Job photos">
            {job.photoCount} photo{job.photoCount === 1 ? "" : "s"} on file (private, owner-only).
          </DetailField>
        ) : null}

        <DetailField icon={Receipt} label="Invoice">
          {job.invoice ? (
            <span className="flex items-center gap-2">
              <StatusBadge status={job.invoice.status} />
              <span>{job.invoice.totalLabel}</span>
            </span>
          ) : isCompleted ? (
            "None yet"
          ) : (
            "Created after the job is completed"
          )}
        </DetailField>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2 border-t border-border/60 pt-5">
        {tel ? (
          <Button asChild variant="outline">
            <a href={tel}>
              <Phone className="size-4" />
              Call
            </a>
          </Button>
        ) : null}
        {mailto ? (
          <Button asChild variant="outline">
            <a href={mailto}>
              <Mail className="size-4" />
              Email
            </a>
          </Button>
        ) : null}
        {!isCompleted && !isInProgress ? <StartJobButton jobId={job.id} /> : null}
        {isInProgress ? <MarkJobCompleteButton jobId={job.id} /> : null}
        {isCompleted ? (
          job.invoice ? (
            <Button asChild>
              <Link href={`/invoices/${job.invoice.id}`}>
                <Receipt className="size-4" />
                Open Invoice
              </Link>
            </Button>
          ) : (
            <CreateInvoiceButton jobId={job.id} />
          )
        ) : null}
        {job.customer ? (
          <Button asChild variant="outline">
            <Link href={`/customers/${job.customer.id}`}>Open Customer</Link>
          </Button>
        ) : null}
        <CopyProjectLinkButton projectToken={job.projectToken} />
        <Button asChild variant="ghost" className="ml-auto">
          <Link href={`/jobs/${job.id}`}>
            <ExternalLink className="size-4" />
            Open Work Order
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

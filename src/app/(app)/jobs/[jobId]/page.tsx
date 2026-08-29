import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AdditionalWorkRequestList } from "@/components/jobs/additional-work-request-list";
import { ApprovedScopeCard } from "@/components/jobs/approved-scope-card";
import { AssignJobMemberForm } from "@/components/jobs/assign-job-member-form";
import { ChangeOrderList } from "@/components/jobs/change-order-list";
import { CopyProjectLinkButton } from "@/components/jobs/copy-project-link-button";
import { CreateChangeOrderForm } from "@/components/jobs/create-change-order-form";
import { CreateInvoiceButton } from "@/components/invoices/create-invoice-button";
import { AddJobPhotoForm } from "@/components/jobs/add-job-photo-form";
import { JobPhotoItem, type JobPhotoDetails } from "@/components/jobs/job-photo-item";
import { JobProblemReportList } from "@/components/jobs/job-problem-report-list";
import { MarkJobCompleteButton } from "@/components/jobs/mark-job-complete-button";
import { StartJobButton } from "@/components/jobs/start-job-button";
import { PageHeader } from "@/components/page-header";
import { RecordNav } from "@/components/record-nav";
import { ScheduleJobForm } from "@/components/jobs/schedule-job-form";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { requireManagementPageAccess } from "@/lib/access";
import { resolveCurrentApprovedProjectTotal } from "@/lib/change-order";
import {
  formatAddress,
  formatDate,
  formatDateTime,
  formatMoney,
  formatTime,
} from "@/lib/format";
import {
  durationPresetForMinutes,
  expectedEnd,
  formatDurationMinutes,
} from "@/lib/job-schedule";
import { resolveApprovedWorkOrderScope } from "@/lib/job-work-order";
import { prisma } from "@/lib/prisma";

function pad(part: number) {
  return String(part).padStart(2, "0");
}

function toDateInput(value: Date) {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function toTimeInput(value: Date) {
  return `${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

export const metadata: Metadata = {
  title: "Work Order",
};

const LINE_ITEM_SELECT = {
  description: true,
  quantity: true,
  unitPrice: true,
  total: true,
  type: true,
} as const;

export default async function JobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  const access = await requireManagementPageAccess();
  const job = await prisma.job.findFirst({
    where: { id: jobId, ...access.scope },
    include: {
      customer: { select: { name: true } },
      property: {
        select: {
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
        },
      },
      estimate: {
        select: {
          id: true,
          status: true,
          total: true,
          lineItems: { orderBy: { createdAt: "asc" }, select: LINE_ITEM_SELECT },
        },
      },
      // The immutable EstimateVersion this Work Order was actually created
      // from -- see resolveApprovedWorkOrderScope() in
      // src/lib/job-work-order.ts for why this is preferred over the (live,
      // mutable) `estimate` relation above.
      approvedEstimateVersion: {
        select: {
          versionNumber: true,
          total: true,
          laborMinimumAdjustment: true,
          approvedAt: true,
          lineItems: { orderBy: { createdAt: "asc" }, select: LINE_ITEM_SELECT },
        },
      },
      invoices: {
        select: { id: true, status: true, total: true },
        take: 1,
        orderBy: { createdAt: "asc" },
      },
      photos: {
        select: { id: true, stage: true, url: true, caption: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      },
      changeOrders: {
        orderBy: { createdAt: "desc" },
        select: { id: true, title: true, status: true, total: true },
      },
      additionalWorkRequests: {
        where: { status: "OPEN" },
        orderBy: { createdAt: "desc" },
        select: { id: true, description: true, createdAt: true, source: true },
      },
      assignedMembership: {
        select: { id: true, user: { select: { name: true, email: true } } },
      },
      problemReports: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          description: true,
          status: true,
          createdAt: true,
          membership: { select: { user: { select: { name: true } } } },
        },
      },
    },
  });

  if (!job) {
    notFound();
  }
  access.assertOwned(job);

  // Assignment candidates: MEMBER-role memberships of THIS Job's own
  // Business only -- see assignJobMember() in src/app/actions/job.ts for
  // the server-side re-validation this list is purely a UX convenience for.
  const eligibleMembers = await prisma.membership.findMany({
    where: { businessId: access.businessId, role: "MEMBER" },
    select: { id: true, user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });

  const isScheduled = Boolean(job.scheduledAt);
  const isCompleted = job.status === "COMPLETED";
  const isInProgress = job.status === "IN_PROGRESS";
  const invoice = job.invoices[0] ?? null;
  const approvedScope = resolveApprovedWorkOrderScope(job);
  const approvedChangeOrders = job.changeOrders.filter(
    (changeOrder) => changeOrder.status === "APPROVED",
  );
  const currentApprovedProjectTotal =
    approvedScope.source === "none"
      ? null
      : resolveCurrentApprovedProjectTotal(
          approvedScope.total,
          job.changeOrders,
        );
  const durationPreset = durationPresetForMinutes(
    job.scheduledDurationMinutes,
  );
  const customHours =
    durationPreset === "custom" && job.scheduledDurationMinutes
      ? (job.scheduledDurationMinutes / 60).toString()
      : "";

  const photosByStage: Record<"BEFORE" | "DURING" | "AFTER", JobPhotoDetails[]> = {
    BEFORE: [],
    DURING: [],
    AFTER: [],
  };
  for (const photo of job.photos) {
    photosByStage[photo.stage].push(photo);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={job.customer?.name ?? "Customer"}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <span>Work Order</span>
            <StatusBadge status={job.status} />
            {job.scheduledAt ? (
              <span>{formatDateTime(job.scheduledAt)}</span>
            ) : (
              <span>Unscheduled</span>
            )}
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {!isCompleted && !isInProgress ? (
            <StartJobButton jobId={job.id} />
          ) : null}
          {isInProgress ? <MarkJobCompleteButton jobId={job.id} /> : null}
          {isCompleted && invoice ? (
            <Button asChild size="sm">
              <Link href={`/invoices/${invoice.id}`}>Open Invoice</Link>
            </Button>
          ) : null}
          <RecordNav
            customerId={job.customerId}
            backHref="/jobs"
            backLabel="Back to Jobs"
          />
        </div>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Work Order Summary</CardTitle>
          <CardDescription>
            The operational record for this job, tied to the approved
            estimate that created it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Work Order ID: {job.id}</p>
          <p>
            Status: <StatusBadge status={job.status} />
          </p>
          <p>Customer: {job.customer?.name ?? "None"}</p>
          <p>
            Service address:{" "}
            {job.property ? formatAddress(job.property) : "None selected"}
          </p>
          <p>
            Linked Estimate:{" "}
            {job.estimate ? (
              <Link
                href={`/estimates/${job.estimate.id}`}
                className="underline underline-offset-4"
              >
                {job.estimate.status} · {formatMoney(job.estimate.total)}
              </Link>
            ) : (
              "None"
            )}
          </p>
          <p>
            Approved version:{" "}
            {approvedScope.source === "version"
              ? `Version ${approvedScope.versionNumber}${
                  approvedScope.approvedAt
                    ? ` · Approved ${formatDateTime(approvedScope.approvedAt)}`
                    : ""
                }`
              : approvedScope.source === "legacy-estimate"
                ? "Not recorded (legacy job — showing the linked estimate's current scope instead)"
                : "None"}
          </p>
          <p>
            Invoice:{" "}
            {invoice ? (
              <Link
                href={`/invoices/${invoice.id}`}
                className="underline underline-offset-4"
              >
                {invoice.status} · {formatMoney(invoice.total)}
              </Link>
            ) : isCompleted ? (
              "None yet"
            ) : (
              "Created after the job is completed"
            )}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Customer Project Portal</CardTitle>
          <CardDescription>
            Share this link so the customer can see project status, approved
            work, and their invoice once it exists. It only ever shows this
            one job — never other customers, jobs, or business data.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          <Link
            href={`/p/${job.projectToken}`}
            className="underline underline-offset-4"
          >
            /p/{job.projectToken}
          </Link>
          <CopyProjectLinkButton projectToken={job.projectToken} />
        </CardContent>
      </Card>

      {isCompleted ? (
        <Card>
          <CardHeader>
            <CardTitle>Continue to Invoice</CardTitle>
            <CardDescription>
              {invoice
                ? "This job already has an invoice. Opening it will not create another one."
                : "Create one invoice from this completed job. A job cannot have two invoices."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {invoice ? (
              <Button asChild size="sm">
                <Link href={`/invoices/${invoice.id}`}>Open Invoice</Link>
              </Button>
            ) : (
              <CreateInvoiceButton jobId={job.id} />
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>
            {isCompleted || isScheduled ? "Appointment" : "Schedule Job"}
          </CardTitle>
          <CardDescription>
            {isCompleted
              ? "Completed jobs keep their saved appointment and cannot be rescheduled."
              : isScheduled
                ? "Reschedule this job without creating another job."
                : "Choose a date, start time, and optional duration."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {job.scheduledAt ? (
            <div className="space-y-1 text-sm">
              <p>Date: {formatDate(job.scheduledAt)}</p>
              <p>Start time: {formatTime(job.scheduledAt)}</p>
              {job.scheduledDurationMinutes ? (
                <>
                  <p>
                    Expected duration:{" "}
                    {formatDurationMinutes(job.scheduledDurationMinutes)}
                  </p>
                  <p>
                    Expected end:{" "}
                    {formatTime(
                      expectedEnd(
                        job.scheduledAt,
                        job.scheduledDurationMinutes,
                      ),
                    )}
                  </p>
                </>
              ) : (
                <p>Expected duration: Not set</p>
              )}
              <p>Customer: {job.customer?.name ?? "None"}</p>
              <p>
                Service address:{" "}
                {job.property ? formatAddress(job.property) : "None selected"}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {isCompleted
                ? "This job was not scheduled."
                : "No appointment yet."}
            </p>
          )}
          {isCompleted ? null : (
            <ScheduleJobForm
              jobId={job.id}
              date={job.scheduledAt ? toDateInput(job.scheduledAt) : ""}
              time={job.scheduledAt ? toTimeInput(job.scheduledAt) : ""}
              durationPreset={durationPreset}
              customHours={customHours}
              isScheduled={isScheduled}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Assigned Employee</CardTitle>
          <CardDescription>
            The one field member assigned to perform this job. Only members
            of {access.workspace.business.name} are eligible. An assigned
            member can open this job from their own Field Home, start it,
            complete it, add photos, report a problem, or flag customer
            requests for more work -- nothing else in the management
            console.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Currently:{" "}
            {job.assignedMembership
              ? `${job.assignedMembership.user.name} (${job.assignedMembership.user.email})`
              : "Unassigned"}
          </p>
          {eligibleMembers.length === 0 ? (
            <p className="text-muted-foreground">
              No team members yet. Invite a MEMBER to this business to assign
              jobs.
            </p>
          ) : (
            <AssignJobMemberForm
              jobId={job.id}
              assignedMembershipId={job.assignedMembership?.id ?? null}
              eligibleMembers={eligibleMembers.map((member) => ({
                id: member.id,
                name: member.user.name,
                email: member.user.email,
              }))}
            />
          )}
        </CardContent>
      </Card>

      <ApprovedScopeCard scope={approvedScope} title="Original Approved Scope" />

      <Card>
        <CardHeader>
          <CardTitle>Current Approved Project Total</CardTitle>
          <CardDescription>
            The original approved scope never changes. Only APPROVED change
            orders below add to the project total -- draft, sent, declined,
            and cancelled change orders never do.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {approvedScope.source === "none" || currentApprovedProjectTotal === null ? (
            <p className="text-muted-foreground">
              No approved estimate is linked to this job yet.
            </p>
          ) : (
            <>
              <p>Original Approved Total: {formatMoney(approvedScope.total)}</p>
              {approvedChangeOrders.length === 0 ? (
                <p>Approved Change Orders: {formatMoney(0)}</p>
              ) : (
                <div>
                  <p>Approved Change Orders:</p>
                  <ul className="ml-4 list-disc">
                    {approvedChangeOrders.map((changeOrder) => (
                      <li key={changeOrder.id}>
                        {changeOrder.title} — {formatMoney(changeOrder.total)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="font-medium">
                Current Approved Project Total:{" "}
                {formatMoney(currentApprovedProjectTotal)}
              </p>
              {invoice && !invoice.total.equals(currentApprovedProjectTotal) ? (
                <p className="text-muted-foreground">
                  Note: this job already has an invoice (
                  {formatMoney(invoice.total)}) created before the current
                  approved project total above. Approved change orders since
                  then are not automatically added to that existing invoice.
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Change Orders</CardTitle>
          <CardDescription>
            Post-approval scope/pricing changes for this job. Only an
            APPROVED change order becomes part of the approved project total
            or invoice -- the original approved estimate above is never
            rewritten.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ChangeOrderList jobId={job.id} changeOrders={job.changeOrders} />
          <CreateChangeOrderForm jobId={job.id} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Additional Work Requests</CardTitle>
          <CardDescription>
            Requests submitted by the customer from their project portal
            (&ldquo;+ Request Additional Work&rdquo;). A request never
            changes approved scope, price, or the invoice by itself -- review
            it and, if appropriate, create a Change Order to price it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AdditionalWorkRequestList
            jobId={job.id}
            requests={job.additionalWorkRequests}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Field Reports</CardTitle>
          <CardDescription>
            Factual operational issues the assigned field member reported
            from this job (access issues, unexpected conditions, safety
            concerns, and similar). Never changes job status, approved
            scope, price, or the invoice by itself.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <JobProblemReportList reports={job.problemReports} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Job Photos</CardTitle>
          <CardDescription>
            Private to this business. Never shown to the customer or
            published anywhere. Completion-photo visibility on the Customer
            Project Portal will be added later with an explicit
            customer-visible/approval control — until then, photos never
            appear there.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <PhotoStageGroup title="Before" photos={photosByStage.BEFORE} />
          <PhotoStageGroup title="During" photos={photosByStage.DURING} />
          <PhotoStageGroup title="After" photos={photosByStage.AFTER} />
          <AddJobPhotoForm jobId={job.id} />
        </CardContent>
      </Card>
    </div>
  );
}

function PhotoStageGroup({
  title,
  photos,
}: {
  title: string;
  photos: JobPhotoDetails[];
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        {title} ({photos.length})
      </p>
      {photos.length === 0 ? (
        <p className="text-sm text-muted-foreground">No photos yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-3">
          {photos.map((photo) => (
            <JobPhotoItem key={photo.id} photo={photo} />
          ))}
        </ul>
      )}
    </div>
  );
}

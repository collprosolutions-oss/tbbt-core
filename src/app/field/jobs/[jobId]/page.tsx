import type { Metadata } from "next";
import { AddFieldJobPhotoForm } from "@/components/field/add-field-job-photo-form";
import { CompleteAssignedJobButton } from "@/components/field/complete-assigned-job-button";
import { FieldTimeClock } from "@/components/field/field-time-clock";
import { ReportProblemForm } from "@/components/field/report-problem-form";
import { RequestAdditionalWorkFieldForm } from "@/components/field/request-additional-work-field-form";
import { StartAssignedJobButton } from "@/components/field/start-assigned-job-button";
import { ApprovedScopeCard } from "@/components/jobs/approved-scope-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { directionsUrl, telHref } from "@/lib/directions";
import { requireAssignedJobPageAccess, assignedJobWhere, requireFieldWorkspace } from "@/lib/field-access";
import { formatAddress, formatDateTime, formatTime } from "@/lib/format";
import { TIME_ACTIVITY_LABELS, isTimeActivityType } from "@/lib/time-cards";
import { resolveApprovedWorkOrderScope } from "@/lib/job-work-order";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Job",
};

const LINE_ITEM_SELECT = {
  description: true,
  quantity: true,
  unitPrice: true,
  total: true,
  type: true,
} as const;

/**
 * Field Job page -- the assigned MEMBER's operational screen for exactly
 * ONE job.
 *
 * SECURITY: `requireAssignedJobPageAccess()` re-confirms assignment and
 * `notFound()`s (aborting the render) before this page fetches a single
 * field of Job/customer detail, and the full-detail query below re-applies
 * the identical `assignedJobWhere()` scoping clause -- so an unassigned or
 * cross-business/cross-member `jobId` in the URL returns exactly a 404,
 * with no Job/customer data anywhere in the response.
 *
 * FIELD-SAFE ONLY: this intentionally never RENDERS unit prices,
 * line-item dollar totals, the Labor Minimum Service Fee Adjustment (a
 * purely financial figure with no operational meaning), or any
 * estimate/project total -- see `hideFinancials` on ApprovedScopeCard and
 * the Approved Additional Work list below, both of which show operational
 * scope (what was approved, how much of it) with none of that pricing.
 * Also never selects/renders estimate margins, invoice/payment fields,
 * customer email, owner/admin notes, or any other Job -- see the MEMBER
 * FIELD JOB PAGE section of the spec.
 */
export default async function FieldJobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  await requireAssignedJobPageAccess(jobId);
  const field = await requireFieldWorkspace();

  const job = await prisma.job.findFirst({
    where: assignedJobWhere(jobId, field),
    select: {
      id: true,
      status: true,
      scheduledAt: true,
      scheduledDurationMinutes: true,
      customer: { select: { name: true, phone: true } },
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
          total: true,
          lineItems: { orderBy: { createdAt: "asc" }, select: LINE_ITEM_SELECT },
        },
      },
      approvedEstimateVersion: {
        select: {
          versionNumber: true,
          total: true,
          laborMinimumAdjustment: true,
          approvedAt: true,
          lineItems: { orderBy: { createdAt: "asc" }, select: LINE_ITEM_SELECT },
        },
      },
      changeOrders: {
        where: { status: "APPROVED" },
        orderBy: { createdAt: "asc" },
        // No `total` -- the field page never renders Change Order
        // pricing (see the FIELD-SAFE ONLY note above), so it is not
        // fetched here at all, not merely left unrendered.
        select: { id: true, title: true, status: true },
      },
      photos: {
        select: { id: true, stage: true, url: true, caption: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  // Re-checked by requireAssignedJobPageAccess() above; this can only be
  // null from a race (e.g. unassigned between the two queries), never from
  // a bad jobId reaching this far.
  if (!job) {
    return null;
  }

  const isCompleted = job.status === "COMPLETED";
  const isInProgress = job.status === "IN_PROGRESS";
  const running = await prisma.timeEntry.findFirst({
    where: {
      businessId: field.businessId,
      membershipId: field.membershipId,
      status: "RUNNING",
      endedAt: null,
    },
    include: {
      job: {
        select: {
          customer: { select: { name: true } },
          property: { select: { addressLine1: true } },
        },
      },
    },
    orderBy: { startedAt: "desc" },
  });
  const approvedScope = resolveApprovedWorkOrderScope(job);
  const hasApprovedScope = approvedScope.source !== "none";

  const directions = directionsUrl(job.property);
  const tel = telHref(job.customer?.phone ?? null);

  const photosByStage: Record<"BEFORE" | "DURING" | "AFTER", typeof job.photos> = {
    BEFORE: [],
    DURING: [],
    AFTER: [],
  };
  for (const photo of job.photos) {
    photosByStage[photo.stage].push(photo);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {job.customer?.name ?? "Customer"}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <StatusBadge status={job.status} />
          <span>
            {job.scheduledAt ? formatDateTime(job.scheduledAt) : "Not yet scheduled"}
          </span>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-3 pt-6 text-sm">
          <p>{job.property ? formatAddress(job.property) : "No address on file"}</p>
          <div className="grid grid-cols-2 gap-2">
            {tel ? (
              <Button asChild variant="outline" className="h-12 text-base">
                <a href={tel}>Call Customer</a>
              </Button>
            ) : (
              <Button variant="outline" className="h-12 text-base" disabled>
                No phone on file
              </Button>
            )}
            {directions ? (
              <Button asChild variant="outline" className="h-12 text-base">
                <a href={directions} target="_blank" rel="noreferrer noopener">
                  Directions
                </a>
              </Button>
            ) : (
              <Button variant="outline" className="h-12 text-base" disabled>
                No address on file
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <FieldTimeClock
        membershipId={field.membershipId}
        defaultJobId={job.id}
        running={
          running
            ? {
                activityType: running.activityType,
                activityLabel:
                  TIME_ACTIVITY_LABELS[
                    isTimeActivityType(running.activityType) ? running.activityType : "OTHER"
                  ],
                jobLabel: running.job?.customer?.name ?? running.job?.property?.addressLine1 ?? null,
                startedAtLabel: formatTime(running.startedAt),
              }
            : null
        }
        assignedJobs={[
          {
            id: job.id,
            label: job.customer?.name ?? (job.property ? formatAddress(job.property) : "This job"),
          },
        ]}
      />

      <div className="space-y-2">
        {!isCompleted && !isInProgress ? <StartAssignedJobButton jobId={job.id} /> : null}
        {isInProgress ? <CompleteAssignedJobButton jobId={job.id} /> : null}
        {isCompleted ? (
          <p className="rounded-lg border border-dashed p-3 text-center text-sm text-muted-foreground">
            This job is complete.
          </p>
        ) : null}
      </div>

      <ApprovedScopeCard
        scope={approvedScope}
        title="Approved Scope"
        hideFinancials
      />

      {job.changeOrders.length > 0 && hasApprovedScope ? (
        <Card>
          <CardHeader>
            <CardTitle>Approved Additional Work</CardTitle>
            <CardDescription>
              Change orders the customer has already approved, on top of the
              original approved scope above.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {job.changeOrders.map((changeOrder) => (
                <li key={changeOrder.id} className="break-words">
                  {changeOrder.title}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Job Photos</CardTitle>
          <CardDescription>Private to the business, never shown to the customer.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <FieldPhotoGroup title="Before" photos={photosByStage.BEFORE} />
          <FieldPhotoGroup title="During" photos={photosByStage.DURING} />
          <FieldPhotoGroup title="After" photos={photosByStage.AFTER} />
          <AddFieldJobPhotoForm jobId={job.id} />
        </CardContent>
      </Card>

      <div className="space-y-2">
        <ReportProblemForm jobId={job.id} />
        <RequestAdditionalWorkFieldForm jobId={job.id} />
      </div>
    </div>
  );
}

function FieldPhotoGroup({
  title,
  photos,
}: {
  title: string;
  photos: { id: string; url: string; caption: string | null }[];
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
            <li key={photo.id} className="w-24">
              <a href={photo.url} target="_blank" rel="noreferrer noopener">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.url}
                  alt={photo.caption ?? "Job photo"}
                  loading="lazy"
                  className="h-24 w-24 rounded-lg border object-cover"
                />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

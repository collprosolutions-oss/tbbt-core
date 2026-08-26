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
import { CreateInvoiceButton } from "@/components/invoices/create-invoice-button";
import { AddJobPhotoForm } from "@/components/jobs/add-job-photo-form";
import { JobPhotoItem, type JobPhotoDetails } from "@/components/jobs/job-photo-item";
import { MarkJobCompleteButton } from "@/components/jobs/mark-job-complete-button";
import { StartJobButton } from "@/components/jobs/start-job-button";
import { PageHeader } from "@/components/page-header";
import { RecordNav } from "@/components/record-nav";
import { ScheduleJobForm } from "@/components/jobs/schedule-job-form";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { requireBusinessAccess } from "@/lib/access";
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
  title: "Job",
};

export default async function JobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  const access = await requireBusinessAccess();
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
      estimate: { select: { id: true, status: true, total: true } },
      invoices: { select: { id: true }, take: 1, orderBy: { createdAt: "asc" } },
      photos: {
        select: { id: true, stage: true, url: true, caption: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!job) {
    notFound();
  }
  access.assertOwned(job);

  const isScheduled = Boolean(job.scheduledAt);
  const isCompleted = job.status === "COMPLETED";
  const isInProgress = job.status === "IN_PROGRESS";
  const invoice = job.invoices[0] ?? null;
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
            <span>Job</span>
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
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            Status: <StatusBadge status={job.status} />
          </p>
          <p>Customer: {job.customer?.name ?? "None"}</p>
          <p>
            Service address:{" "}
            {job.property ? formatAddress(job.property) : "None selected"}
          </p>
          <p>
            Scheduled:{" "}
            {job.scheduledAt ? formatDateTime(job.scheduledAt) : "Unscheduled"}
          </p>
          <p>
            Estimate:{" "}
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
            Invoice:{" "}
            {invoice ? (
              <Link
                href={`/invoices/${invoice.id}`}
                className="underline underline-offset-4"
              >
                Open Invoice
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
          <CardTitle>Job Photos</CardTitle>
          <CardDescription>
            Private to this business. Never shown to the customer or
            published anywhere.
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

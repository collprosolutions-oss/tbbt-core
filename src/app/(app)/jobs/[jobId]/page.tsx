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
import { MarkJobCompleteButton } from "@/components/jobs/mark-job-complete-button";
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
    },
  });

  if (!job) {
    notFound();
  }
  access.assertOwned(job);

  const isScheduled = Boolean(job.scheduledAt);
  const isCompleted = job.status === "COMPLETED";
  const durationPreset = durationPresetForMinutes(
    job.scheduledDurationMinutes,
  );
  const customHours =
    durationPreset === "custom" && job.scheduledDurationMinutes
      ? (job.scheduledDurationMinutes / 60).toString()
      : "";

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
          {job.status === "SCHEDULED" ? (
            <MarkJobCompleteButton jobId={job.id} />
          ) : null}
          {job.status === "COMPLETED" && job.invoices[0] ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/invoices/${job.invoices[0].id}`}>Open invoice</Link>
            </Button>
          ) : null}
          {job.status === "COMPLETED" && !job.invoices[0] ? (
            <CreateInvoiceButton jobId={job.id} />
          ) : null}
          <RecordNav
            customerId={job.customerId}
            backHref="/jobs"
            backLabel="Back to Schedule / Jobs"
          />
        </div>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>{isScheduled ? "Appointment" : "Schedule Job"}</CardTitle>
          <CardDescription>
            {isCompleted
              ? "Completed jobs keep their saved appointment."
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
          ) : null}
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
          <p>Customer: {job.customer?.name ?? "None"}</p>
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
            Service address:{" "}
            {job.property ? formatAddress(job.property) : "None selected"}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

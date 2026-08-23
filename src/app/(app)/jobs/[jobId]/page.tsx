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
import { ScheduleJobForm } from "@/components/jobs/schedule-job-form";
import { Button } from "@/components/ui/button";
import { requireBusinessAccess } from "@/lib/access";
import { prisma } from "@/lib/prisma";

function toDateTimeLocal(value: Date) {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
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
      property: { select: { addressLine1: true } },
      estimate: { select: { id: true, status: true, total: true } },
      invoices: { select: { id: true }, take: 1, orderBy: { createdAt: "asc" } },
    },
  });

  if (!job) {
    notFound();
  }
  access.assertOwned(job);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Job</h1>
        <p className="mt-1 text-sm text-muted-foreground">Status: {job.status}</p>
        {job.scheduledAt ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Scheduled: {job.scheduledAt.toLocaleString()}
          </p>
        ) : null}
        <div className="mt-3">
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
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
          <CardDescription>Save or replace the job date and time.</CardDescription>
        </CardHeader>
        <CardContent>
          <ScheduleJobForm
            jobId={job.id}
            scheduledAt={job.scheduledAt ? toDateTimeLocal(job.scheduledAt) : ""}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Conversion</CardTitle>
          <CardDescription>
            Created from an approved estimate. No schedule yet.
          </CardDescription>
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
                {job.estimate.status} · {job.estimate.total.toString()}
              </Link>
            ) : (
              "None"
            )}
          </p>
          <p>Address: {job.property?.addressLine1 ?? "None"}</p>
        </CardContent>
      </Card>
    </div>
  );
}

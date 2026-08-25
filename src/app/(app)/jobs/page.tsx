import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireBusinessAccess } from "@/lib/access";
import {
  formatAddress,
  formatDate,
  formatDateTime,
  formatMoney,
  formatTime,
} from "@/lib/format";
import { formatDurationMinutes } from "@/lib/job-schedule";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Jobs",
};

export default async function JobsPage() {
  const access = await requireBusinessAccess();
  const jobs = await prisma.job.findMany({
    where: access.scope,
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
      estimate: { select: { total: true } },
    },
  });

  const unscheduled = jobs
    .filter(
      (job) => job.status !== "COMPLETED" && (!job.scheduledAt || job.status === "UNSCHEDULED"),
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const upcoming = jobs
    .filter(
      (job) =>
        job.status !== "COMPLETED" &&
        job.status !== "UNSCHEDULED" &&
        Boolean(job.scheduledAt),
    )
    .sort(
      (a, b) =>
        (a.scheduledAt?.getTime() ?? 0) - (b.scheduledAt?.getTime() ?? 0),
    );
  const completed = jobs
    .filter((job) => job.status === "COMPLETED")
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Jobs"
        description={`Jobs for ${access.workspace.business.name}.`}
      />

      {jobs.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No jobs yet</CardTitle>
            <CardDescription>
              Create a job from an approved estimate.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm">
              <Link href="/estimates">Open estimates</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <JobGroup
            title="Unscheduled"
            empty="No unscheduled jobs."
            jobs={unscheduled}
          />
          <JobGroup
            title="Upcoming"
            empty="No upcoming jobs."
            jobs={upcoming}
          />
          <JobGroup
            title="Completed"
            empty="No completed jobs."
            jobs={completed}
          />
        </>
      )}
    </div>
  );
}

function JobGroup({
  title,
  empty,
  jobs,
}: {
  title: string;
  empty: string;
  jobs: Array<{
    id: string;
    status: string;
    scheduledAt: Date | null;
    scheduledDurationMinutes: number | null;
    customer: { name: string } | null;
    property: {
      addressLine1: string;
      addressLine2: string | null;
      city: string | null;
      region: string | null;
      postalCode: string | null;
    } | null;
    estimate: { total: { toString(): string } } | null;
  }>;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        jobs.map((job) => (
          <Card key={job.id}>
            <CardHeader>
              <CardTitle>{job.customer?.name ?? "Customer"}</CardTitle>
              <CardDescription>
                {job.scheduledAt
                  ? `${formatDate(job.scheduledAt)} · ${formatTime(job.scheduledAt)}${
                      job.scheduledDurationMinutes
                        ? ` · ${formatDurationMinutes(job.scheduledDurationMinutes)}`
                        : ""
                    }`
                  : "Not scheduled"}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={job.status} />
                  {job.estimate ? (
                    <span>Estimate {formatMoney(job.estimate.total)}</span>
                  ) : null}
                </div>
                <p className="text-muted-foreground">
                  {job.property ? formatAddress(job.property) : "No service address"}
                </p>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href={`/jobs/${job.id}`}>Open</Link>
              </Button>
            </CardContent>
          </Card>
        ))
      )}
    </section>
  );
}

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
import { formatDateTime, formatMoney } from "@/lib/format";
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
      estimate: { select: { total: true } },
    },
    orderBy: { createdAt: "desc" },
  });

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
        <div className="space-y-3">
          {jobs.map((job) => (
            <Card key={job.id}>
              <CardHeader>
                <CardTitle>{job.customer?.name ?? "Customer"}</CardTitle>
                <CardDescription>
                  {job.scheduledAt
                    ? formatDateTime(job.scheduledAt)
                    : "Not scheduled"}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={job.status} />
                  {job.estimate ? (
                    <span>Estimate {formatMoney(job.estimate.total)}</span>
                  ) : null}
                </div>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/jobs/${job.id}`}>Open</Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

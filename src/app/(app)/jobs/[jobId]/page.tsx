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
import { requireBusinessAccess } from "@/lib/access";
import { prisma } from "@/lib/prisma";

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
      </div>

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

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JobProfitabilityCloseoutView } from "@/components/jobs/job-profitability-closeout";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { loadJobProfitabilityCloseout } from "@/lib/job-profitability-closeout-data";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Job Profitability",
};

export default async function JobProfitabilityPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  const access = await requireManagementPageAccess();
  const closeout = await loadJobProfitabilityCloseout(prisma, access, jobId);
  if (!closeout) {
    notFound();
  }

  return (
    <PageContainer>
      <PageHeader
        title="Job Profitability"
        description={
          <div className="flex flex-wrap items-center gap-2">
            <span>{closeout.customerName}</span>
            <span>Read-only closeout from recorded job facts.</span>
          </div>
        }
      >
        <Link href={`/jobs/${jobId}`} className="text-sm underline underline-offset-4">
          Back to Work Order
        </Link>
      </PageHeader>
      <JobProfitabilityCloseoutView closeout={closeout} />
    </PageContainer>
  );
}

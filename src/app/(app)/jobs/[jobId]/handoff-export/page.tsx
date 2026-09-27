import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { JobPropertyExportPanel } from "@/components/jobs/job-property-export-panel";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import {
  JobPropertyExportError,
  buildCompletedJobPropertyExport,
  canExportCompletedJobProperty,
} from "@/lib/job-property-export";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Export completed job/property",
};

export default async function JobPropertyExportPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  const access = await requireManagementPageAccess();
  if (!canExportCompletedJobProperty(access.workspace.role)) {
    redirect("/access-restricted");
  }

  let document;
  try {
    document = await buildCompletedJobPropertyExport(prisma, access, {
      jobId,
      includePrivateCustomer: false,
      includePhotos: false,
    });
  } catch (error) {
    if (error instanceof JobPropertyExportError && error.code !== "FORBIDDEN") {
      notFound();
    }
    throw error;
  }

  return (
    <PageContainer>
      <PageHeader
        title="Export completed job/property"
        description="OWNER-authorized v1 packet of recorded facts and provenance. Private customer data and photos stay redacted unless you expressly authorize them."
      >
        <Link href="/jobs/handoff-export" className="text-sm underline underline-offset-4">
          All exportable completed jobs
        </Link>
      </PageHeader>
      <JobPropertyExportPanel document={document} />
    </PageContainer>
  );
}

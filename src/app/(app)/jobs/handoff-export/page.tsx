import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { JobPropertyExportPicker } from "@/components/jobs/job-property-export-picker";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import {
  canExportCompletedJobProperty,
  listExportableCompletedJobProperties,
} from "@/lib/job-property-export";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Completed job/property export",
};

export default async function JobPropertyExportPickerPage() {
  const access = await requireManagementPageAccess();
  if (!canExportCompletedJobProperty(access.workspace.role)) {
    redirect("/access-restricted");
  }

  const jobs = await listExportableCompletedJobProperties(prisma, access);

  return (
    <PageContainer>
      <PageHeader
        title="Completed job/property export"
        description="OWNER-authorized, versioned snapshot of one recorded completed job and its property. Possible future HQ Watchfolio or REIOS use only — no live sync and no shared database."
      />
      <JobPropertyExportPicker jobs={jobs} />
    </PageContainer>
  );
}

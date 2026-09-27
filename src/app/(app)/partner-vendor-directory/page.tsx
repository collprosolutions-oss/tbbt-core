import type { Metadata } from "next";
import { PartnerVendorDirectoryWorkspace } from "@/components/partner-vendor-directory/workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import {
  DIRECTORY_LIMITS_MESSAGE,
  loadPartnerVendorDirectory,
  requirePartnerVendorDirectoryAccess,
} from "@/lib/partner-vendor-directory";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Partner & vendor directory",
};

export default async function PartnerVendorDirectoryPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    kind?: string;
    source?: string;
    review?: string;
    selected?: string;
  }>;
}) {
  const access = await requireManagementPageAccess();
  requirePartnerVendorDirectoryAccess(access);
  const params = await searchParams;
  const workspace = await loadPartnerVendorDirectory(prisma, access, params);

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Partner & vendor directory"
        description={`Private opportunities for ${access.workspace.business.name}. ${DIRECTORY_LIMITS_MESSAGE}`}
      />
      <PartnerVendorDirectoryWorkspace workspace={workspace} />
    </PageContainer>
  );
}

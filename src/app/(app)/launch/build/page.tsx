import type { Metadata } from "next";
import Link from "next/link";
import { BuildCompanyForm } from "@/components/launch/build-company-form";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireManagementPageAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Build my company",
};

export default async function BuildCompanyPage() {
  const access = await requireManagementPageAccess();
  requireBusinessCapability(access, CAPABILITIES.USE_AI_ASSIST);
  requireBusinessRole(access, "OWNER");
  const proposals = await prisma.companySetupProposal.findMany({
    where: { businessId: access.businessId },
    include: { items: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  return (
    <PageContainer>
      <PageHeader
        title="Build my company"
        description="Describe the business in plain language. TBBT proposes setup choices. You approve every consequential write."
      >
        <Button asChild variant="outline">
          <Link href="/launch">Back to launch</Link>
        </Button>
      </PageHeader>
      <BuildCompanyForm proposals={proposals} />
    </PageContainer>
  );
}

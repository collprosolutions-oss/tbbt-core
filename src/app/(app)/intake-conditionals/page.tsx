import type { Metadata } from "next";
import { IntakeConditionWorkspace } from "@/components/intake-conditionals/workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { requireBusinessRole } from "@/lib/authorization";
import { loadIntakeConditionWorkspace } from "@/lib/intake-conditionals-ops";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Intake condition drafts",
};

export default async function IntakeConditionalsPage({
  searchParams,
}: {
  searchParams: Promise<{ trade?: string }>;
}) {
  const access = await requireManagementPageAccess();
  requireBusinessRole(access, "OWNER");
  const params = await searchParams;
  const workspace = await loadIntakeConditionWorkspace(prisma, access, params.trade);

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Intake condition drafts"
        description="OWNER-only. Draft allowlisted extra questions and preview them. This does not change archived Cleaning public V1/V2, Handyman V1, frozen requests, or the live public hire form."
      />
      <IntakeConditionWorkspace workspace={workspace} />
    </PageContainer>
  );
}

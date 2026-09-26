import type { Metadata } from "next";
import Link from "next/link";
import { FillInBenchWorkspace } from "@/components/team/fill-in-bench-workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { loadOwnedFillInBench } from "@/lib/fill-in-bench";
import { prisma } from "@/lib/prisma";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { hasProductCapability } from "@/lib/product-entitlements";
import { loadWorkforceMembers } from "@/lib/workforce-data";

export const metadata: Metadata = {
  title: "Fill-In Bench",
};

export default async function FillInBenchPage() {
  const access = await requireManagementPageAccess();
  const canManageWorkforce = await hasProductCapability(
    prisma,
    access.businessId,
    PRODUCT_CAPABILITIES.TEAM_MANAGEMENT,
  );
  const [bench, members] = canManageWorkforce
    ? await Promise.all([
        loadOwnedFillInBench(prisma, access),
        loadWorkforceMembers(prisma, access.businessId),
      ])
    : [[], []];

  return (
    <PageContainer>
      <PageHeader
        title="Fill-In Bench"
        description={
          <>
            Backup workers, subcontractors, helpers, and future hires for{" "}
            {access.workspace.business.name}. Profiles are never public and are not a
            cross-business marketplace.{" "}
            <Link href="/team" className="underline underline-offset-4">
              Back to Team
            </Link>
          </>
        }
      />
      {canManageWorkforce ? (
        <FillInBenchWorkspace
          bench={bench}
          teamMembers={members.map((member) => ({
            membershipId: member.membershipId,
            name: member.name,
          }))}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Team management is not on this plan, so the Fill-In Bench stays hidden.
        </p>
      )}
    </PageContainer>
  );
}

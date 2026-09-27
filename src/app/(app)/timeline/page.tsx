import type { Metadata } from "next";
import { TimelineWorkspace } from "@/components/timeline/timeline-workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { loadBusinessTimeline } from "@/lib/business-timeline";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Business Timeline",
};

export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; customerId?: string }>;
}) {
  const access = await requireManagementPageAccess();
  const params = await searchParams;
  const source = await loadBusinessTimeline(prisma, access, {
    category: params.category,
    customerId: params.customerId,
  });

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Business Timeline"
        description={`Recorded business events for ${access.workspace.business.name}. Only persisted facts appear here. This is not an audit log and not generated history.`}
      />
      <TimelineWorkspace source={source} />
    </PageContainer>
  );
}

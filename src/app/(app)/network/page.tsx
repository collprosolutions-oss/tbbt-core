import type { Metadata } from "next";
import { BsosNetworkWorkspace } from "@/components/bsos-network/network-workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import {
  NETWORK_NOT_IN_NAV_MESSAGE,
  NETWORK_PRIVACY_MESSAGE,
  NETWORK_SCHEMA_UNAVAILABLE_MESSAGE,
} from "@/lib/bsos-network";
import { loadNetworkWorkspace } from "@/lib/bsos-network-data";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "BSOS Network",
};

export default async function BsosNetworkPage({
  searchParams,
}: {
  searchParams: Promise<{ trade?: string; serviceArea?: string }>;
}) {
  const access = await requireManagementPageAccess();
  const params = await searchParams;
  const workspace = await loadNetworkWorkspace(prisma, access, {
    trade: params.trade,
    serviceArea: params.serviceArea,
  });

  return (
    <PageContainer>
      <PageHeader
        title="BSOS Network"
        description={`${NETWORK_PRIVACY_MESSAGE} ${NETWORK_NOT_IN_NAV_MESSAGE}${
          workspace.available ? "" : ` ${NETWORK_SCHEMA_UNAVAILABLE_MESSAGE}`
        }`}
      />
      <BsosNetworkWorkspace
        own={workspace.own}
        suggestions={workspace.suggestions}
        listings={workspace.listings}
        canManage={workspace.available && access.workspace.role === "OWNER"}
        unavailable={!workspace.available}
        tradeFilter={params.trade?.trim() ?? ""}
        serviceAreaFilter={params.serviceArea?.trim() ?? ""}
      />
    </PageContainer>
  );
}

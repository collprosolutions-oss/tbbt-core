import type { MembershipRole } from "@prisma/client";
import type { MarketingArea } from "@/lib/marketing";
import type { MarketingSource } from "@/lib/marketing-data";

export type MarketingWorkspaceProps = {
  area: MarketingArea;
  source: MarketingSource;
  viewerRole: MembershipRole;
};

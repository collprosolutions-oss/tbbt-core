import type { MembershipRole } from "@prisma/client";
import type { MarketingArea } from "@/lib/marketing";
import type { MarketingSource } from "@/lib/marketing-data";
import type { MarketingConnectionCard } from "@/lib/marketing-connections/presenter";

export type MarketingConnectionSelection = {
  token: string;
  label: string;
  candidates: Array<{ externalId: string; displayName: string }>;
} | null;

export type MarketingWorkspaceProps = {
  area: MarketingArea;
  source: MarketingSource;
  viewerRole: MembershipRole;
  connectionCards?: MarketingConnectionCard[];
  connectionSelection?: MarketingConnectionSelection;
  connectionError?: string | null;
};

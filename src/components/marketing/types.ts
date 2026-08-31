import type { MarketingArea } from "@/lib/marketing";
import type { MarketingSource } from "@/lib/marketing-data";

export type MarketingWorkspaceProps = {
  area: MarketingArea;
  source: MarketingSource;
};

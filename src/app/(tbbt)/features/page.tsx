import type { Metadata } from "next";
import { TbbtFeaturesPage } from "@/components/tbbt-marketing/features";
import { readRequestHost } from "@/lib/request-host";
import { tbbtMarketingMetadata } from "@/lib/tbbt-marketing-seo";

export async function generateMetadata(): Promise<Metadata> {
  return tbbtMarketingMetadata({
    page: "features",
    pathname: "/features",
    host: await readRequestHost(),
  });
}

export default function FeaturesRoute() {
  return <TbbtFeaturesPage />;
}

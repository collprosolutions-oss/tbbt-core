import type { Metadata } from "next";
import { TbbtPrivacyPage } from "@/components/tbbt-marketing/legal";
import { readRequestHost } from "@/lib/request-host";
import { tbbtMarketingMetadata } from "@/lib/tbbt-marketing-seo";

export async function generateMetadata(): Promise<Metadata> {
  return tbbtMarketingMetadata({
    page: "privacy",
    pathname: "/privacy",
    host: await readRequestHost(),
  });
}

export default function PrivacyRoute() {
  return <TbbtPrivacyPage />;
}

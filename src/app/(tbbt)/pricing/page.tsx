import type { Metadata } from "next";
import { TbbtPricingPage } from "@/components/tbbt-marketing/pricing";
import { readRequestHost } from "@/lib/request-host";
import { tbbtMarketingMetadata } from "@/lib/tbbt-marketing-seo";

export async function generateMetadata(): Promise<Metadata> {
  return tbbtMarketingMetadata({
    page: "pricing",
    pathname: "/pricing",
    host: await readRequestHost(),
  });
}

export default function PricingRoute() {
  return <TbbtPricingPage />;
}

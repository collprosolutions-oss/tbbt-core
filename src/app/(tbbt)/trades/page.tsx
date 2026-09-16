import type { Metadata } from "next";
import { TbbtTradesPage } from "@/components/tbbt-marketing/trades";
import { readRequestHost } from "@/lib/request-host";
import { tbbtMarketingMetadata } from "@/lib/tbbt-marketing-seo";

export async function generateMetadata(): Promise<Metadata> {
  return tbbtMarketingMetadata({
    page: "trades",
    pathname: "/trades",
    host: await readRequestHost(),
  });
}

export default function TradesRoute() {
  return <TbbtTradesPage />;
}

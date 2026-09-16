import type { Metadata } from "next";
import { TbbtTermsPage } from "@/components/tbbt-marketing/legal";
import { readRequestHost } from "@/lib/request-host";
import { tbbtMarketingMetadata } from "@/lib/tbbt-marketing-seo";

export async function generateMetadata(): Promise<Metadata> {
  return tbbtMarketingMetadata({
    page: "terms",
    pathname: "/terms",
    host: await readRequestHost(),
  });
}

export default function TermsRoute() {
  return <TbbtTermsPage />;
}

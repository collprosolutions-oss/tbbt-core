import type { Metadata } from "next";
import { TbbtResourcesPage } from "@/components/tbbt-marketing/resources";
import { readRequestHost } from "@/lib/request-host";
import { tbbtMarketingMetadata } from "@/lib/tbbt-marketing-seo";

export async function generateMetadata(): Promise<Metadata> {
  return tbbtMarketingMetadata({
    page: "resources",
    pathname: "/resources",
    host: await readRequestHost(),
  });
}

export default function ResourcesRoute() {
  return <TbbtResourcesPage />;
}

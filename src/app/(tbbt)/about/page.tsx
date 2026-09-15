import type { Metadata } from "next";
import { TbbtAboutPage } from "@/components/tbbt-marketing/about";
import { readRequestHost } from "@/lib/request-host";
import { tbbtMarketingMetadata } from "@/lib/tbbt-marketing-seo";

export async function generateMetadata(): Promise<Metadata> {
  return tbbtMarketingMetadata({
    page: "about",
    pathname: "/about",
    host: await readRequestHost(),
  });
}

export default function AboutRoute() {
  return <TbbtAboutPage />;
}

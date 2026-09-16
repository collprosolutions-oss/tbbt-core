import type { Metadata } from "next";
import { TbbtContactPage } from "@/components/tbbt-marketing/legal";
import { readRequestHost } from "@/lib/request-host";
import { tbbtMarketingMetadata } from "@/lib/tbbt-marketing-seo";

export async function generateMetadata(): Promise<Metadata> {
  return tbbtMarketingMetadata({
    page: "contact",
    pathname: "/contact",
    host: await readRequestHost(),
  });
}

export default function ContactRoute() {
  return <TbbtContactPage />;
}

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TbbtHomePage } from "@/components/tbbt-marketing/home";
import { readRequestHost } from "@/lib/request-host";
import { shouldServeTbbtMarketingHome } from "@/lib/tbbt-marketing-host";
import { tbbtMarketingMetadata } from "@/lib/tbbt-marketing-seo";

export async function generateMetadata(): Promise<Metadata> {
  return tbbtMarketingMetadata({
    page: "home",
    pathname: "/",
    host: await readRequestHost(),
  });
}

export default async function TbbtHomePreviewPage() {
  const host = await readRequestHost();
  if (shouldServeTbbtMarketingHome(host)) {
    redirect("/");
  }
  return <TbbtHomePage />;
}

import type { ReactNode } from "react";
import { TbbtMarketingShell } from "@/components/tbbt-marketing/shell";
import { readRequestHost } from "@/lib/request-host";

export default async function TbbtMarketingLayout({
  children,
}: {
  children: ReactNode;
}) {
  const host = await readRequestHost();
  return <TbbtMarketingShell host={host}>{children}</TbbtMarketingShell>;
}

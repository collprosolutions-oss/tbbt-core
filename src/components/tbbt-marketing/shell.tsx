import type { ReactNode } from "react";
import { Great_Vibes } from "next/font/google";
import { TbbtMarketingFooter } from "@/components/tbbt-marketing/footer";
import { TbbtMarketingHeader } from "@/components/tbbt-marketing/header";
import {
  isTbbtMarketingIndexableHost,
  tbbtMarketingHomeHref,
} from "@/lib/tbbt-marketing-host";
import "@/components/tbbt-marketing/tbbt-marketing.css";

const tbbtScript = Great_Vibes({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-tbbt-script",
});

export function TbbtMarketingShell({
  host,
  children,
}: {
  host: string | null | undefined;
  children: ReactNode;
}) {
  const homeHref = tbbtMarketingHomeHref(host);
  const preview = !isTbbtMarketingIndexableHost(host);

  return (
    <div className={`tbbt-site ${tbbtScript.variable}`}>
      {preview ? (
        <div className="tbbt-preview-note">
          Previewing TBBT marketing pages. Canonical site: www.tbbtool.com.
          CollPro remains at collproreno.com.
        </div>
      ) : null}
      <TbbtMarketingHeader homeHref={homeHref} />
      <main>{children}</main>
      <TbbtMarketingFooter homeHref={homeHref} />
    </div>
  );
}

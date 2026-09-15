import type { ReactNode } from "react";
import { TbbtMarketingFooter } from "@/components/tbbt-marketing/footer";
import { TbbtMarketingHeader } from "@/components/tbbt-marketing/header";
import {
  isTbbtMarketingIndexableHost,
  tbbtMarketingHomeHref,
} from "@/lib/tbbt-marketing-host";
import "@/components/tbbt-marketing/tbbt-marketing.css";

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
    <div className="tbbt-site">
      {preview ? (
        <div className="tbbt-preview-note">
          Previewing TBBT marketing pages. Canonical site: tbbtools.com. CollPro
          remains at collproreno.com.
        </div>
      ) : null}
      <TbbtMarketingHeader homeHref={homeHref} />
      <main>{children}</main>
      <TbbtMarketingFooter homeHref={homeHref} />
    </div>
  );
}

import Link from "next/link";
import {
  TBBT_BRAND_MOTTO,
  TBBT_LEGAL_NAV,
  TBBT_NAV,
  TBBT_PRODUCT_LONG_NAME,
  TBBT_PRODUCT_NAME,
  TBBT_TAGLINE,
} from "@/lib/tbbt-marketing";

export function TbbtMarketingFooter({ homeHref }: { homeHref: string }) {
  return (
    <footer className="tbbt-footer">
      <div className="tbbt-wrap tbbt-footer-grid">
        <div>
          <p className="tbbt-kicker">{TBBT_PRODUCT_NAME}</p>
          <p className="tbbt-motto">{TBBT_BRAND_MOTTO}</p>
          <p className="tbbt-muted" style={{ marginTop: "0.45rem" }}>
            {TBBT_PRODUCT_LONG_NAME}
          </p>
          <p className="tbbt-muted" style={{ marginTop: "0.7rem", maxWidth: "22rem" }}>
            {TBBT_TAGLINE}
          </p>
        </div>
        <nav aria-label="TBBT pages">
          {TBBT_NAV.map((item) => (
            <Link key={item.key} href={item.key === "home" ? homeHref : item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
        <nav aria-label="Legal">
          {TBBT_LEGAL_NAV.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}

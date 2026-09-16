import Link from "next/link";
import {
  TBBT_LEGAL_NAV,
  TBBT_NAV,
  TBBT_PRODUCT_LONG_NAME,
  TBBT_PRODUCT_NAME,
} from "@/lib/tbbt-marketing";

const TBBT_LOGO_SIZE = { width: 1659, height: 948 } as const;

export function TbbtMarketingFooter({ homeHref }: { homeHref: string }) {
  return (
    <footer className="tbbt-footer">
      <div className="tbbt-wrap tbbt-footer-grid">
        <Link href={homeHref} className="tbbt-logo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/tbbt-logo.png"
            alt={TBBT_PRODUCT_NAME}
            width={TBBT_LOGO_SIZE.width}
            height={TBBT_LOGO_SIZE.height}
          />
          <span className="tbbt-logo-text">
            <strong>{TBBT_PRODUCT_NAME}</strong>
            <span>{TBBT_PRODUCT_LONG_NAME}</span>
          </span>
        </Link>
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

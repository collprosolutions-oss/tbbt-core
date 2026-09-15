"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import {
  TBBT_NAV,
  TBBT_PRODUCT_LONG_NAME,
  TBBT_PRODUCT_NAME,
  TBBT_SIGN_IN_HREF,
  TBBT_SIGN_UP_HREF,
  TBBT_TRIAL_NAV_LABEL,
} from "@/lib/tbbt-marketing";

const TBBT_LOGO_SIZE = { width: 1659, height: 948 } as const;

export function TbbtMarketingHeader({ homeHref }: { homeHref: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  function isActive(href: string, key: string) {
    if (key === "home") {
      return pathname === "/" || pathname === "/home";
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <header className="tbbt-header">
      <div className="tbbt-wrap tbbt-header-inner">
        <Link href={homeHref} className="tbbt-logo" onClick={() => setOpen(false)}>
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

        <nav className="tbbt-nav" aria-label="TBBT">
          {TBBT_NAV.map((item) => {
            const href = item.key === "home" ? homeHref : item.href;
            return (
              <Link
                key={item.key}
                href={href}
                aria-current={isActive(item.href, item.key) ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="tbbt-header-actions">
          <Link href={TBBT_SIGN_IN_HREF} className="tbbt-btn tbbt-btn--ghost">
            Sign In
          </Link>
          <Link href={TBBT_SIGN_UP_HREF} className="tbbt-btn tbbt-btn--primary">
            {TBBT_TRIAL_NAV_LABEL}
          </Link>
        </div>

        <button
          type="button"
          className="tbbt-menu-btn"
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>

      {open ? (
        <div className="tbbt-wrap tbbt-mobile-panel">
          {TBBT_NAV.map((item) => {
            const href = item.key === "home" ? homeHref : item.href;
            return (
              <Link key={item.key} href={href} onClick={() => setOpen(false)}>
                {item.label}
              </Link>
            );
          })}
          <Link href={TBBT_SIGN_IN_HREF} onClick={() => setOpen(false)}>
            Sign In
          </Link>
          <Link
            href={TBBT_SIGN_UP_HREF}
            className="tbbt-btn tbbt-btn--primary"
            onClick={() => setOpen(false)}
          >
            {TBBT_TRIAL_NAV_LABEL}
          </Link>
        </div>
      ) : null}
    </header>
  );
}

"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, Menu, Phone, X } from "lucide-react";
import { PRIMARY_CTA_LABEL } from "@/lib/public-site";

type NavItem = {
  href: string;
  label: string;
  match: "exact" | "prefix";
};

export function PublicHeader({
  name,
  logoSrc,
  phone,
  homeHref,
  requestHref,
  servicesHref,
  aboutHref,
  projectsHref,
  reviewsHref,
  serviceAreaHref,
  contactHref,
  callHref,
}: {
  name: string;
  logoSrc: string | null;
  phone: string | null;
  homeHref: string;
  requestHref: string;
  servicesHref: string;
  aboutHref: string;
  projectsHref: string;
  reviewsHref: string;
  serviceAreaHref: string;
  contactHref: string;
  callHref: string | null;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  const nav: NavItem[] = [
    { href: homeHref, label: "Home", match: "exact" },
    { href: servicesHref, label: "Services", match: "prefix" },
    { href: aboutHref, label: "About Us", match: "prefix" },
    { href: projectsHref, label: "Projects", match: "prefix" },
    { href: reviewsHref, label: "Reviews", match: "prefix" },
    { href: serviceAreaHref, label: "Service Area", match: "prefix" },
    { href: contactHref, label: "Contact", match: "prefix" },
  ];

  function isActive(item: NavItem) {
    if (item.match === "exact") {
      return pathname === item.href || pathname === "/";
    }
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  }

  return (
    <header className="public-header">
      <div className="public-container public-header-inner">
        <Link href={homeHref} className="public-logo" onClick={() => setOpen(false)}>
          {logoSrc ? (
            <Image
              src={logoSrc}
              alt={`${name} logo`}
              width={72}
              height={72}
              priority
            />
          ) : (
            <span className="text-sm font-extrabold tracking-[0.12em] uppercase">
              {name}
            </span>
          )}
        </Link>

        <nav className="public-nav" aria-label="Primary">
          {nav.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className="public-nav-link"
              data-active={isActive(item) ? "true" : "false"}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="public-header-actions">
          {callHref ? (
            <a href={callHref} className="public-header-phone">
              <span className="public-header-phone-number">{phone}</span>
              <span className="public-header-phone-label">Call or Text</span>
            </a>
          ) : null}
          <Link href={requestHref} className="public-btn public-btn-primary">
            {PRIMARY_CTA_LABEL}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>

        <div className="public-header-mobile">
          {callHref ? (
            <a
              href={callHref}
              className="public-icon-btn"
              aria-label={`Call or text ${name} at ${phone}`}
            >
              <Phone className="size-5" />
            </a>
          ) : null}
          <Link href={requestHref} className="public-mobile-cta">
            {PRIMARY_CTA_LABEL}
          </Link>
          <button
            type="button"
            className="public-icon-btn"
            aria-expanded={open}
            aria-controls="public-mobile-nav"
            onClick={() => setOpen((current) => !current)}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
            <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
          </button>
        </div>
      </div>

      {open ? (
        <nav id="public-mobile-nav" className="public-mobile-nav" aria-label="Mobile">
          {nav.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              data-active={isActive(item) ? "true" : "false"}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </Link>
          ))}
          {callHref ? (
            <a href={callHref} onClick={() => setOpen(false)}>
              Call or Text {phone}
            </a>
          ) : null}
        </nav>
      ) : null}
    </header>
  );
}

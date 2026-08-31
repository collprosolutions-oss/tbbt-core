"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Menu, Phone, X } from "lucide-react";
import { PRIMARY_CTA_LABEL } from "@/lib/public-site";

export function PublicHeader({
  name,
  logoSrc,
  phone,
  homeHref,
  requestHref,
  servicesHref,
  aboutHref,
  callHref,
}: {
  name: string;
  logoSrc: string | null;
  phone: string | null;
  homeHref: string;
  requestHref: string;
  servicesHref: string;
  aboutHref: string;
  callHref: string | null;
}) {
  const [open, setOpen] = useState(false);

  const nav = [
    { href: homeHref, label: "Home" },
    { href: servicesHref, label: "Services" },
    { href: aboutHref, label: "About Us" },
    { href: `${homeHref}#projects`, label: "Projects" },
    { href: `${homeHref}#reviews`, label: "Reviews" },
    { href: `${homeHref}#service-area`, label: "Service Area" },
    { href: `${homeHref}#contact`, label: "Contact" },
  ] as const;

  function close() {
    setOpen(false);
  }

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-[var(--public-navy-deep)] text-white">
      <div className="public-container flex h-[4.75rem] items-center justify-between gap-4 lg:h-20">
        <Link href={homeHref} className="flex min-w-0 items-center gap-3 rounded-md">
          {logoSrc ? (
            <Image
              src={logoSrc}
              alt={`${name} logo`}
              width={72}
              height={72}
              className="size-14 rounded-md bg-black object-contain lg:size-16"
              priority
            />
          ) : null}
          <span className="hidden min-w-0 truncate text-base font-semibold tracking-tight sm:block lg:text-lg">
            {name}
          </span>
        </Link>

        <nav className="hidden items-center gap-5 xl:flex" aria-label="Primary">
          {nav.map((item) => (
            <a
              key={item.label}
              href={item.href}
              className="text-[0.95rem] font-medium text-white/85 hover:text-white"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-4 lg:flex">
          {callHref ? (
            <a href={callHref} className="text-right">
              <span className="block text-lg font-bold tracking-tight">{phone}</span>
              <span className="block text-xs font-semibold tracking-[0.14em] text-[var(--public-blue-soft)] uppercase">
                Call or Text
              </span>
            </a>
          ) : null}
          <Link href={requestHref} className="public-btn public-btn-primary px-5">
            {PRIMARY_CTA_LABEL}
          </Link>
        </div>

        <div className="flex items-center gap-2 lg:hidden">
          {callHref ? (
            <a
              href={callHref}
              className="inline-flex size-12 items-center justify-center rounded-lg bg-white text-[var(--public-navy)]"
              aria-label={`Call or text ${name} at ${phone}`}
            >
              <Phone className="size-5" />
            </a>
          ) : null}
          <Link
            href={requestHref}
            className="inline-flex h-12 max-w-[7.5rem] items-center justify-center rounded-lg bg-[var(--public-blue)] px-2 text-[0.65rem] leading-tight font-bold tracking-wide text-white uppercase sm:max-w-none sm:px-3 sm:text-xs"
          >
            {PRIMARY_CTA_LABEL}
          </Link>
          <button
            type="button"
            className="inline-flex size-12 items-center justify-center rounded-lg bg-white text-[var(--public-navy)]"
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
        <nav
          id="public-mobile-nav"
          className="border-t border-white/15 px-5 py-4 lg:hidden"
          aria-label="Mobile"
        >
          <ul className="space-y-1">
            {nav.map((item) => (
              <li key={item.label}>
                <a
                  href={item.href}
                  onClick={close}
                  className="block rounded-lg px-3 py-3 text-lg font-medium text-white hover:bg-white/10"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-col gap-3">
            <Link href={requestHref} onClick={close} className="public-btn public-btn-primary">
              {PRIMARY_CTA_LABEL}
            </Link>
            {callHref ? (
              <a href={callHref} className="public-btn public-btn-ghost">
                Call or Text {phone}
              </a>
            ) : null}
          </div>
        </nav>
      ) : null}
    </header>
  );
}

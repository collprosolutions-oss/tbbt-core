"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Menu, Phone, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const NAV = [
  { href: "#services", label: "Services" },
  { href: "#how-it-works", label: "How It Works" },
  { href: "#service-area", label: "Service Area" },
] as const;

export function PublicHeader({
  name,
  logoSrc,
  phone,
  homeHref,
  requestHref,
  callHref,
}: {
  name: string;
  logoSrc: string | null;
  phone: string | null;
  homeHref: string;
  requestHref: string;
  callHref: string | null;
}) {
  const [open, setOpen] = useState(false);

  function close() {
    setOpen(false);
  }

  return (
    <header className="sticky top-0 z-40 border-b border-black/10 bg-[var(--public-navy-deep)] text-white">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4">
        <Link href={homeHref} className="flex min-w-0 items-center gap-3 rounded-md">
          {logoSrc ? (
            <Image
              src={logoSrc}
              alt={`${name} logo`}
              width={48}
              height={48}
              className="size-12 rounded-md bg-black object-contain"
              priority
            />
          ) : null}
          <span className="truncate text-sm font-semibold tracking-tight sm:text-base">
            {name}
          </span>
        </Link>

        <nav className="hidden items-center gap-5 lg:flex" aria-label="Primary">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={`${homeHref}${item.href}`}
              className="text-sm font-medium text-white/85 hover:text-white"
            >
              {item.label}
            </a>
          ))}
          <Link
            href={requestHref}
            className="text-sm font-semibold text-white underline-offset-4 hover:underline"
          >
            Request Service
          </Link>
          {callHref ? (
            <a
              href={callHref}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-white"
            >
              <Phone className="size-4" aria-hidden="true" />
              {phone}
            </a>
          ) : null}
        </nav>

        <div className="flex items-center gap-2 lg:hidden">
          {callHref ? (
            <Button asChild size="icon" variant="secondary" className="size-11 bg-white text-[var(--public-navy)]">
              <a href={callHref} aria-label={`Call ${name} at ${phone}`}>
                <Phone className="size-5" />
              </a>
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="size-11 bg-white text-[var(--public-navy)]"
            aria-expanded={open}
            aria-controls="public-mobile-nav"
            onClick={() => setOpen((current) => !current)}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
            <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
          </Button>
        </div>
      </div>

      {open ? (
        <nav
          id="public-mobile-nav"
          className="border-t border-white/15 px-4 py-4 lg:hidden"
          aria-label="Mobile"
        >
          <ul className="space-y-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <a
                  href={`${homeHref}${item.href}`}
                  onClick={close}
                  className="block rounded-lg px-3 py-3 text-base font-medium text-white hover:bg-white/10"
                >
                  {item.label}
                </a>
              </li>
            ))}
            <li>
              <Link
                href={requestHref}
                onClick={close}
                className="block rounded-lg px-3 py-3 text-base font-semibold text-white hover:bg-white/10"
              >
                Request Service
              </Link>
            </li>
            {callHref ? (
              <li>
                <a
                  href={callHref}
                  className="block rounded-lg px-3 py-3 text-base font-semibold text-white hover:bg-white/10"
                >
                  Call {phone}
                </a>
              </li>
            ) : null}
          </ul>
        </nav>
      ) : null}
    </header>
  );
}

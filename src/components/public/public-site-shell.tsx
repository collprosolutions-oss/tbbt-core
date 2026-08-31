import type { ReactNode } from "react";
import { PublicHeader } from "@/components/public/public-header";
import { PublicLightTheme } from "@/components/public/public-light-theme";
import "@/components/public/public-site.css";
import { telHref } from "@/lib/directions";
import {
  publicDisplayName,
  publicLogoSrc,
  publicPhone,
  type PublicBusiness,
} from "@/lib/public-site";

export function PublicSiteShell({
  business,
  children,
}: {
  business: PublicBusiness;
  children: ReactNode;
}) {
  const name = publicDisplayName(business);
  const phone = publicPhone(business.slug);
  const logoSrc = publicLogoSrc(business.slug);
  const requestHref = `/r/${business.slug}`;
  const homeHref = `/hire/${business.slug}`;
  const callHref = telHref(phone);

  return (
    <div className="public-site">
      <PublicLightTheme />
      <PublicHeader
        name={name}
        logoSrc={logoSrc}
        phone={phone}
        homeHref={homeHref}
        requestHref={requestHref}
        callHref={callHref}
      />
      {children}
      <footer className="border-t border-border bg-[var(--public-navy-deep)] text-white">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold">{name}</p>
            <p className="mt-1 text-sm text-white/75">
              Handyman services. Request online or call to get started.
            </p>
          </div>
          <div className="flex flex-col gap-2 text-sm sm:items-end">
            {callHref ? (
              <a className="font-medium text-white underline-offset-4 hover:underline" href={callHref}>
                {phone}
              </a>
            ) : null}
            <a className="text-white/80 underline-offset-4 hover:underline" href={requestHref}>
              Request Service
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

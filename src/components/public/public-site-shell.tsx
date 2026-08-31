import type { ReactNode } from "react";
import { PublicFooter } from "@/components/public/public-footer";
import { PublicHeader } from "@/components/public/public-header";
import { PublicLightTheme } from "@/components/public/public-light-theme";
import "@/components/public/public-site.css";
import { telHref } from "@/lib/directions";
import {
  popularPublicCategories,
  publicAboutPath,
  publicDisplayName,
  publicHomePath,
  publicLogoSrc,
  publicPhone,
  publicRequestPath,
  publicServicesPath,
  type PublicBusiness,
  type PublicCatalogGroup,
} from "@/lib/public-site";

export function PublicSiteShell({
  business,
  groups = [],
  children,
}: {
  business: PublicBusiness;
  groups?: PublicCatalogGroup[];
  children: ReactNode;
}) {
  const name = publicDisplayName(business);
  const phone = publicPhone(business.slug);
  const logoSrc = publicLogoSrc(business.slug);
  const requestHref = publicRequestPath(business.slug);
  const homeHref = publicHomePath(business.slug);
  const servicesHref = publicServicesPath(business.slug);
  const aboutHref = publicAboutPath(business.slug);
  const callHref = telHref(phone);
  const categories = popularPublicCategories(groups);

  return (
    <div className="public-site">
      <PublicLightTheme />
      <PublicHeader
        name={name}
        logoSrc={logoSrc}
        phone={phone}
        homeHref={homeHref}
        requestHref={requestHref}
        servicesHref={servicesHref}
        aboutHref={aboutHref}
        callHref={callHref}
      />
      {children}
      <PublicFooter
        name={name}
        logoSrc={logoSrc}
        phone={phone}
        homeHref={homeHref}
        requestHref={requestHref}
        servicesHref={servicesHref}
        aboutHref={aboutHref}
        callHref={callHref}
        categories={categories}
      />
    </div>
  );
}

import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { PublicFooter } from "@/components/public/public-footer";
import { PublicHeader } from "@/components/public/public-header";
import { PublicLightTheme } from "@/components/public/public-light-theme";
import "@/components/public/public-site.css";
import { smsHref } from "@/lib/directions";
import {
  popularPublicCategories,
  publicAboutPath,
  publicContactPath,
  publicDisplayName,
  publicHomePath,
  publicLogoSrc,
  publicPhone,
  publicProjectsPath,
  publicRequestPath,
  publicReviewsPath,
  publicServiceAreaPath,
  publicServicesPath,
  type PublicBusiness,
  type PublicCatalogGroup,
} from "@/lib/public-site";

const publicSans = Inter({
  subsets: ["latin"],
  display: "swap",
});

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
  const textHref = smsHref(phone);
  const categories = popularPublicCategories(groups);

  return (
    <div className={`public-site ${publicSans.className}`}>
      <PublicLightTheme />
      <PublicHeader
        name={name}
        logoSrc={logoSrc}
        phone={phone}
        homeHref={homeHref}
        requestHref={requestHref}
        servicesHref={publicServicesPath(business.slug)}
        aboutHref={publicAboutPath(business.slug)}
        projectsHref={publicProjectsPath(business.slug)}
        reviewsHref={publicReviewsPath(business.slug)}
        serviceAreaHref={publicServiceAreaPath(business.slug)}
        contactHref={publicContactPath(business.slug)}
        smsHref={textHref}
      />
      {children}
      <PublicFooter
        name={name}
        logoSrc={logoSrc}
        phone={phone}
        homeHref={homeHref}
        requestHref={requestHref}
        servicesHref={publicServicesPath(business.slug)}
        aboutHref={publicAboutPath(business.slug)}
        projectsHref={publicProjectsPath(business.slug)}
        reviewsHref={publicReviewsPath(business.slug)}
        serviceAreaHref={publicServiceAreaPath(business.slug)}
        contactHref={publicContactPath(business.slug)}
        smsHref={textHref}
        categories={categories}
      />
    </div>
  );
}

import type { Metadata } from "next";
import "@/components/public/public-site.css";
import { PublicHome } from "@/components/public/public-home";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import {
  COLLPRO_RENO_DISPLAY_NAME,
  localBusinessJsonLd,
  publicDisplayName,
  publicLogoSrc,
  publicPhone,
} from "@/lib/public-site";
import { loadPublicHomeImages } from "@/lib/public-site-images";
import { prisma } from "@/lib/prisma";
import { loadDefaultPublicBusiness, loadPublicCatalog } from "@/lib/public-site-data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: `${COLLPRO_RENO_DISPLAY_NAME} | Handyman Services` },
  description:
    "Request handyman services from CollPro Reno Handyman Services. Choose one or more tasks for a single visit request.",
};

export default async function HomePage() {
  const business = await loadDefaultPublicBusiness();

  if (!business) {
    return (
      <main className="public-site mx-auto flex min-h-full max-w-md items-center px-4 py-16">
        <div className="rounded-xl border border-border bg-white p-6">
          <h1 className="text-xl font-semibold">{COLLPRO_RENO_DISPLAY_NAME}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The public website is not available yet because the business record
            could not be found.
          </p>
        </div>
      </main>
    );
  }

  const catalog = await loadPublicCatalog(business);
  const homeImages = await loadPublicHomeImages(prisma, business.id, catalog.groups);
  const name = publicDisplayName(business);
  const jsonLd = localBusinessJsonLd({
    name,
    slug: business.slug,
    phone: publicPhone(business.slug),
    logoSrc: publicLogoSrc(business.slug),
    description: `Handyman services from ${name}. Request repairs, installations, mounting, carpentry, and other home projects.`,
  });

  return (
    <PublicSiteShell business={business} groups={catalog.groups}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <PublicHome
        business={business}
        items={catalog.items}
        groups={catalog.groups}
        images={homeImages}
      />
    </PublicSiteShell>
  );
}

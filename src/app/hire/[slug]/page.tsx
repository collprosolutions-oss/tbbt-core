import type { Metadata } from "next";
import "@/components/public/public-site.css";
import { PublicHome } from "@/components/public/public-home";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import {
  localBusinessJsonLd,
  publicDisplayName,
  publicLogoSrc,
  publicPhone,
} from "@/lib/public-site";
import { loadPublicSite } from "@/lib/public-site-data";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const site = await loadPublicSite(slug);
  if (!site) {
    return {
      title: { absolute: "Page unavailable" },
      description: "This business website could not be found.",
    };
  }
  const name = publicDisplayName(site.business);
  return {
    title: { absolute: `${name} | Handyman Services` },
    description: `Request handyman services from ${name}. Choose one or more tasks for a single visit request.`,
  };
}

export default async function PublicHirePage({ params }: PageProps) {
  const { slug } = await params;
  const site = await loadPublicSite(slug);

  if (!site) {
    return (
      <main className="public-site mx-auto flex min-h-full max-w-md items-center px-4 py-16">
        <div className="rounded-xl border border-border bg-white p-6">
          <h1 className="text-xl font-semibold">Page unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This business could not be found.
          </p>
        </div>
      </main>
    );
  }

  const name = publicDisplayName(site.business);
  const jsonLd = localBusinessJsonLd({
    name,
    slug: site.business.slug,
    phone: publicPhone(site.business.slug),
    logoSrc: publicLogoSrc(site.business.slug),
    description: `Handyman services from ${name}. Request repairs, installations, mounting, carpentry, and other home projects.`,
  });

  return (
    <PublicSiteShell business={site.business}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <PublicHome
        business={site.business}
        items={site.items}
        groups={site.groups}
      />
    </PublicSiteShell>
  );
}

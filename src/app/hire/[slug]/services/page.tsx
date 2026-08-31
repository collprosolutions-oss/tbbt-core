import type { Metadata } from "next";
import "@/components/public/public-site.css";
import { HomeCatalogContinue } from "@/components/public/home-catalog-continue";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { PUBLIC_PRICING_DISCLAIMER, publicDisplayName } from "@/lib/public-site";
import { loadPublicSite } from "@/lib/public-site-data";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ category?: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const site = await loadPublicSite(slug);
  const name = site ? publicDisplayName(site.business) : "Services";
  return {
    title: { absolute: `Services | ${name}` },
    description: `Browse handyman services from ${name}. Select one or more tasks, then continue to request service.`,
  };
}

export default async function PublicServicesPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const query = await searchParams;
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

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main className="bg-[var(--background)]">
        <div className="public-container py-12 lg:py-16">
          <p className="text-sm font-bold tracking-[0.18em] text-[var(--public-blue)] uppercase">
            Services
          </p>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight sm:text-5xl">
            Select your work
          </h1>
          <p className="mt-4 max-w-3xl text-lg leading-8 text-muted-foreground">
            Browse by category, search, and choose one or more tasks. Continue
            when you are ready to send the request.
          </p>
          <p className="mt-3 max-w-3xl text-base text-muted-foreground">
            {PUBLIC_PRICING_DISCLAIMER}
          </p>
          <div className="mt-10">
            <HomeCatalogContinue
              slug={site.business.slug}
              items={site.items}
              groups={site.groups}
              initialCategory={query.category}
            />
          </div>
        </div>
      </main>
    </PublicSiteShell>
  );
}

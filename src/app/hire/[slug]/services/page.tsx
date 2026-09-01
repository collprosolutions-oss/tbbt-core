import type { Metadata } from "next";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicServicesBrowser } from "@/components/public/public-services-browser";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { PublicUnavailable } from "@/components/public/public-unavailable";
import { telHref } from "@/lib/directions";
import {
  Clock,
  Home,
  MessageSquare,
  Shield,
} from "lucide-react";
import {
  TRUST_POINTS,
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicRequestPath,
  publicServicesPath,
} from "@/lib/public-site";
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

const TRUST_ICONS = [Shield, Clock, MessageSquare, Home] as const;

export default async function PublicServicesPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const site = await loadPublicSite(slug);

  if (!site) {
    return (
      <PublicUnavailable
        title="Page unavailable"
        body="This business could not be found."
      />
    );
  }

  const name = publicDisplayName(site.business);
  const phone = publicPhone(site.business.slug);
  const requestHref = publicRequestPath(site.business.slug);

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(site.business.slug)}
          current="Services"
          title="Services"
          description="Professional handyman services to keep your home running smoothly and looking its best."
        />
        <section className="bg-[var(--public-paper)]">
          <div className="public-container public-section">
            <h2 className="public-section-title">Browse Our Services</h2>
            <div className="mt-10">
              <PublicServicesBrowser
                slug={site.business.slug}
                items={site.items}
                groups={site.groups}
                servicesHref={publicServicesPath(site.business.slug)}
                initialCategory={query.category}
              />
            </div>
          </div>
        </section>
        <PublicCtaBar
          title="Ready to get started?"
          body={`Tell ${name} about your project and we will review the request before preparing a written estimate.`}
          requestHref={requestHref}
          callHref={telHref(phone)}
          phone={phone}
        />
        <section className="bg-[var(--public-navy)] text-white">
          <div className="public-container grid gap-8 py-10 sm:grid-cols-2 xl:grid-cols-4">
            {TRUST_POINTS.map((point, index) => {
              const Icon = TRUST_ICONS[index] ?? Shield;
              return (
                <div key={point.title} className="text-center">
                  <Icon className="mx-auto size-7 text-[var(--public-blue-soft)]" aria-hidden="true" />
                  <h3 className="mt-3 font-bold">{point.title}</h3>
                  <p className="mt-2 text-sm text-white/70">{point.body}</p>
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </PublicSiteShell>
  );
}

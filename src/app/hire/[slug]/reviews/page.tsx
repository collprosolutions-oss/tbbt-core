import type { Metadata } from "next";
import {
  Clock,
  Home,
  MessageSquare,
  Shield,
} from "lucide-react";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { PublicUnavailable } from "@/components/public/public-unavailable";
import { telHref } from "@/lib/directions";
import {
  REVIEWS_PLACEHOLDER_COPY,
  TRUST_POINTS,
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicRequestPath,
} from "@/lib/public-site";
import { loadPublicSite } from "@/lib/public-site-data";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const site = await loadPublicSite(slug);
  const name = site ? publicDisplayName(site.business) : "Reviews";
  return {
    title: { absolute: `Reviews | ${name}` },
    description: `Customer feedback for ${name} will appear here when it is approved for public display.`,
  };
}

const TRUST_ICONS = [Shield, Clock, MessageSquare, Home] as const;

export default async function PublicReviewsPage({ params }: PageProps) {
  const { slug } = await params;
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

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(site.business.slug)}
          current="Reviews"
          title="Reviews"
          description={`See what customers say about working with ${name} as public feedback becomes available.`}
        />
        <section className="bg-[var(--public-navy)] text-white">
          <div className="public-container grid gap-8 py-10 sm:grid-cols-2 xl:grid-cols-4">
            {TRUST_POINTS.map((point, index) => {
              const Icon = TRUST_ICONS[index] ?? Shield;
              return (
                <div key={point.title} className="public-trust-item">
                  <span className="public-trust-icon">
                    <Icon className="size-7" aria-hidden="true" />
                  </span>
                  <div>
                    <h2>{point.title}</h2>
                    <p>{point.body}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        <section className="bg-[var(--public-paper)]">
          <div className="public-container py-16">
            <div className="public-empty-card mx-auto max-w-2xl">
              <h2 className="text-3xl font-extrabold tracking-tight uppercase">
                Customer Reviews
              </h2>
              <p className="mt-4 text-lg leading-8 text-muted-foreground">
                {REVIEWS_PLACEHOLDER_COPY}
              </p>
            </div>
          </div>
        </section>
        <PublicCtaBar
          title="Ready to get started?"
          body="Let's bring your vision to life with quality work you can trust."
          requestHref={publicRequestPath(site.business.slug)}
          callHref={telHref(phone)}
          phone={phone}
        />
      </main>
    </PublicSiteShell>
  );
}

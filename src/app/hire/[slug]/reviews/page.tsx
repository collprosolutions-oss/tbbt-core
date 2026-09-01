import type { Metadata } from "next";
import { Clock, MessageSquare, Shield } from "lucide-react";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { PublicUnavailable } from "@/components/public/public-unavailable";
import { smsHref } from "@/lib/directions";
import {
  PUBLIC_REVIEWS_HERO_IMAGE,
  REVIEWS_PLACEHOLDER_COPY,
  TRUST_POINTS,
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicRequestPath,
} from "@/lib/public-site";
import { loadPublicSite } from "@/lib/public-site-data";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const site = await loadPublicSite(slug);
  const name = site ? publicDisplayName(site.business) : "Reviews";
  return {
    title: { absolute: `Reviews | ${name}` },
    description: `Customer feedback for ${name} will appear here when it is approved for public display.`,
  };
}

const HIGHLIGHTS = [
  { title: "Quality Work", body: TRUST_POINTS[0].body, Icon: Shield },
  { title: "Clear Estimates", body: TRUST_POINTS[1].body, Icon: Clock },
  { title: "Great Communication", body: TRUST_POINTS[2].body, Icon: MessageSquare },
] as const;

export default async function PublicReviewsPage({ params }: PageProps) {
  const { slug } = await params;
  const site = await loadPublicSite(slug);
  if (!site) {
    return <PublicUnavailable title="Page unavailable" body="This business could not be found." />;
  }
  const phone = publicPhone(site.business.slug);
  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(site.business.slug)}
          current="Reviews"
          title={<>Real Reviews.<br /><em>Real Results.</em></>}
          description="We take pride in our work. Public customer feedback will be shown here when it is available."
          imageSrc={PUBLIC_REVIEWS_HERO_IMAGE}
          phone={phone}
          smsHref={smsHref(phone)}
          requestHref={publicRequestPath(site.business.slug)}
        />
        <section className="bg-white">
          <div className="public-container grid gap-8 py-14 md:grid-cols-3">
            {HIGHLIGHTS.map((item) => (
              <div key={item.title} className="text-center">
                <item.Icon className="mx-auto size-8 text-[var(--public-blue)]" />
                <h2 className="mt-4 font-extrabold">{item.title}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{item.body}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="bg-[var(--public-paper)] py-16">
          <div className="public-container">
            <div className="public-empty-card mx-auto max-w-2xl">
              <h2 className="text-3xl font-extrabold uppercase">Customer Reviews</h2>
              <p className="mt-4 text-lg text-muted-foreground">{REVIEWS_PLACEHOLDER_COPY}</p>
            </div>
          </div>
        </section>
        <PublicCtaBar
          title="Ready to start your project?"
          body="Let's make your home better — together. We're just a text away."
          requestHref={publicRequestPath(site.business.slug)}
          smsHref={smsHref(phone)}
          phone={phone}
        />
      </main>
    </PublicSiteShell>
  );
}

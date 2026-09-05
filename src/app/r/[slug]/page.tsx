import type { Metadata } from "next";
import { MessageSquare, Shield, Star } from "lucide-react";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { MultiServiceRequestFlow } from "@/components/public/request-flow";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { PublicUnavailable } from "@/components/public/public-unavailable";
import { smsHref } from "@/lib/directions";
import {
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicQuoteHeroImage,
  publicQuoteHeroPosition,
  publicRequestPath,
} from "@/lib/public-site";
import { resolveBusinessServiceArea } from "@/lib/business-service-area";
import { loadPublicSite } from "@/lib/public-site-data";
import { parseSelectedWorkSearch } from "@/lib/selected-work";
import { isBusinessStorageConfigured } from "@/lib/business-storage";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    services?: string;
    other?: string;
    otherText?: string;
    otherQty?: string;
  }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const site = await loadPublicSite(slug);
  const name = site ? publicDisplayName(site.business) : "Request service";
  return {
    title: { absolute: `Request Service | ${name}` },
    description: `Request one or more handyman tasks from ${name} in a single visit request.`,
  };
}

export default async function PublicIntakePage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const site = await loadPublicSite(slug);
  if (!site) {
    return <PublicUnavailable title="Request unavailable" body="This request could not be submitted." />;
  }

  const initialSelected = parseSelectedWorkSearch(
    query,
    new Set(site.items.map((item) => item.id)),
  );
  const name = publicDisplayName(site.business);
  const phone = publicPhone(site.business.slug);
  const textHref = smsHref(phone);

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          className="public-quote-hero"
          homeHref={publicHomePath(site.business.slug)}
          current="Request a Quote"
          title="Request a Quote"
          accent="Let's get your project started."
          description="Fill out the form below. We will review your request before preparing a written estimate."
          imageSrc={publicQuoteHeroImage(site.business.slug)}
          objectPosition={publicQuoteHeroPosition(site.business.slug)}
          phone={phone}
          smsHref={textHref}
          requestHref={publicRequestPath(site.business.slug)}
          showQuote={false}
        />
        <section className="public-quote-points" aria-label="What to expect">
          <div className="public-container public-quote-points-grid">
            <div className="public-quote-point">
              <MessageSquare className="size-7 text-[var(--public-blue)]" aria-hidden="true" />
              <div>
                <h2>Fast Response</h2>
                <p>Text us about your project and we will follow up.</p>
              </div>
            </div>
            <div className="public-quote-point">
              <Shield className="size-7 text-[var(--public-blue)]" aria-hidden="true" />
              <div>
                <h2>Dependable</h2>
                <p>Your request becomes an organized project record.</p>
              </div>
            </div>
            <div className="public-quote-point">
              <Star className="size-7 text-[var(--public-blue)]" aria-hidden="true" />
              <div>
                <h2>Quality Work</h2>
                <p>Quality-minded workmanship on the jobs we take on.</p>
              </div>
            </div>
          </div>
        </section>
        <section className="bg-[var(--public-paper)]">
          <div className="public-container py-12">
            <div className="public-form-card">
              <h2 className="mb-6 text-2xl font-extrabold uppercase">Request Service</h2>
              <MultiServiceRequestFlow
                slug={site.business.slug}
                businessName={name}
                items={site.items}
                groups={site.groups}
                initialSelected={initialSelected}
                photosEnabled={isBusinessStorageConfigured()}
                serviceArea={resolveBusinessServiceArea(site.business)}
              />
            </div>
          </div>
        </section>
        <PublicCtaBar
          title="Prefer to text instead?"
          body="Send project details to CollPro Reno and we will follow up."
          requestHref={publicRequestPath(site.business.slug)}
          smsHref={textHref}
          phone={phone}
          showQuote={false}
        />
      </main>
    </PublicSiteShell>
  );
}

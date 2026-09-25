import type { Metadata } from "next";
import { MessageSquare, Shield, Star } from "lucide-react";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { MultiServiceRequestFlow } from "@/components/public/request-flow";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { smsHref } from "@/lib/directions";
import {
  isCollProRenoSlug,
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicQuoteHeroImage,
  publicQuoteHeroPosition,
  publicRequestPath,
} from "@/lib/public-site";
import { resolveBusinessServiceArea } from "@/lib/business-service-area";
import { requirePublicSite } from "@/lib/require-public-site";
import { publicTenantPageMetadata } from "@/lib/public-site-seo";
import { parseSelectedWorkSearch } from "@/lib/selected-work";
import { isBusinessStorageConfigured } from "@/lib/business-storage";
import { loadPublicNextAvailableLabel } from "@/lib/availability-data";
import { prisma } from "@/lib/prisma";
import {
  currentIntakeSchema,
  publicIntakeSchemaProjection,
} from "@/lib/intake-schema";

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
  const site = await requirePublicSite(slug);
  const name = publicDisplayName(site.business);
  return publicTenantPageMetadata({
    business: site.business,
    title: `Request Service | ${name}`,
    description:
      site.business.activeTrades?.[0]?.requestDescription ??
      `Request service from ${name} in a single visit request.`,
    pathname: publicRequestPath(site.business.slug),
  });
}

export default async function PublicIntakePage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const site = await requirePublicSite(slug);

  const initialSelected = parseSelectedWorkSearch(
    query,
    new Set(site.items.map((item) => item.id)),
  );
  const name = publicDisplayName(site.business);
  const phone = publicPhone(site.business);
  const textHref = smsHref(phone);
  const nextAvailableLabel = await loadPublicNextAvailableLabel(prisma, site.business.id);
  const activeTradeCodes =
    site.business.activeTrades?.map((trade) => trade.code) ?? [site.business.tradeCode];
  const intakeSchemasByTrade = Object.fromEntries(
    activeTradeCodes.map((code) => [
      code,
      publicIntakeSchemaProjection(currentIntakeSchema(code)),
    ]),
  );

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          className={isCollProRenoSlug(site.business.slug) ? "public-quote-hero public-quote-hero-collpro" : "public-quote-hero"}
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
              {nextAvailableLabel ? (
                <p className="mb-6 text-sm text-[var(--public-ink)]">
                  Next available: {nextAvailableLabel}
                </p>
              ) : null}
              <MultiServiceRequestFlow
                slug={site.business.slug}
                businessName={name}
                items={site.items}
                groups={site.groups}
                initialSelected={initialSelected}
                photosEnabled={isBusinessStorageConfigured()}
                serviceArea={resolveBusinessServiceArea(site.business)}
                intakeSchemasByTrade={intakeSchemasByTrade}
                activeTrades={
                  site.business.activeTrades?.map((trade) => ({
                    code: trade.code,
                    label: trade.label,
                  })) ?? []
                }
              />
            </div>
          </div>
        </section>
        <PublicCtaBar
          title="Prefer to text instead?"
          body={`Send project details to ${name} and we will follow up.`}
          requestHref={publicRequestPath(site.business.slug)}
          smsHref={textHref}
          phone={phone}
          showQuote={false}
        />
      </main>
    </PublicSiteShell>
  );
}

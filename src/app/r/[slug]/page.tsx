import type { Metadata } from "next";
import { Check, Clock } from "lucide-react";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { MultiServiceRequestFlow } from "@/components/public/request-flow";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { PublicUnavailable } from "@/components/public/public-unavailable";
import type { SelectedWorkState } from "@/components/public/service-picker";
import { telHref } from "@/lib/directions";
import {
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicRequestPath,
} from "@/lib/public-site";
import { loadPublicSite } from "@/lib/public-site-data";
import { isStorageConfigured } from "@/lib/storage";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ services?: string; other?: string; otherText?: string }>;
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

export default async function PublicIntakePage({
  params,
  searchParams,
}: PageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const site = await loadPublicSite(slug);

  if (!site) {
    return (
      <PublicUnavailable
        title="Request unavailable"
        body="This request could not be submitted."
      />
    );
  }

  const validIds = new Set(site.items.map((item) => item.id));
  const requestedIds = (query.services ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((id) => validIds.has(id));
  const initialSelected: SelectedWorkState = {
    catalogIds: requestedIds,
    includeOther: query.other === "1" || query.other === "true",
    otherDescription: (query.otherText ?? "").trim(),
  };
  const name = publicDisplayName(site.business);
  const phone = publicPhone(site.business.slug);
  const callHref = telHref(phone);

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(site.business.slug)}
          current="Request a Quote"
          title="Request a Quote"
          accent="Let's get your project started."
          description="Fill out the form below and we will review your request before preparing a written estimate."
        />
        <section className="bg-[var(--public-paper)]">
          <div className="public-container grid items-start gap-8 py-12 lg:grid-cols-[minmax(0,1.35fr)_minmax(16rem,0.65fr)]">
            <div className="public-form-card public-quote-form">
              <p className="sr-only">Request Service</p>
              <h2 className="mb-6 text-2xl font-extrabold tracking-tight uppercase">
                Request Service
              </h2>
              <MultiServiceRequestFlow
                slug={site.business.slug}
                businessName={name}
                items={site.items}
                groups={site.groups}
                initialSelected={initialSelected}
                photosEnabled={isStorageConfigured()}
              />
            </div>
            <aside className="space-y-4">
              <div className="public-side-card">
                <h2 className="flex items-center gap-2 text-sm font-extrabold tracking-[0.08em] uppercase">
                  <Check className="size-4 text-[var(--public-blue)]" aria-hidden="true" />
                  The more details, the better
                </h2>
                <ul className="mt-4 space-y-2 text-sm leading-6 text-muted-foreground">
                  <li>Describe the work you need</li>
                  <li>Include rooms, counts, or dimensions when you know them</li>
                  <li>Mention finishes or materials if they matter</li>
                  <li>Add photos when you can</li>
                </ul>
              </div>
              <div className="public-side-card">
                <h2 className="flex items-center gap-2 text-sm font-extrabold tracking-[0.08em] uppercase">
                  <Clock className="size-4 text-[var(--public-blue)]" aria-hidden="true" />
                  Prefer to talk now?
                </h2>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  Call or text and we will help you get the request started.
                </p>
                {callHref ? (
                  <a href={callHref} className="mt-3 block text-lg font-bold text-[var(--public-navy)]">
                    {phone}
                  </a>
                ) : null}
              </div>
            </aside>
          </div>
        </section>
        <PublicCtaBar
          title="Ready to get started?"
          body="Let's bring your vision to life with quality work you can trust."
          requestHref={publicRequestPath(site.business.slug)}
          callHref={callHref}
          phone={phone}
        />
      </main>
    </PublicSiteShell>
  );
}

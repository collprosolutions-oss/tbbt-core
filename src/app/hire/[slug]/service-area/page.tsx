import type { Metadata } from "next";
import { Clock, Home, MapPin, Shield } from "lucide-react";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { PublicUnavailable } from "@/components/public/public-unavailable";
import { smsHref } from "@/lib/directions";
import {
  PUBLIC_AREA_HERO_IMAGE,
  SERVICE_AREA_COPY,
  SERVICE_AREA_MAP_SRC,
  TEXT_US_LABEL,
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
  const name = site ? publicDisplayName(site.business) : "Service Area";
  return { title: { absolute: `Service Area | ${name}` }, description: SERVICE_AREA_COPY };
}

const POINTS = [
  { title: TRUST_POINTS[0].title, body: TRUST_POINTS[0].body, Icon: Shield },
  { title: TRUST_POINTS[1].title, body: TRUST_POINTS[1].body, Icon: Clock },
  { title: "Local & Community Focused", body: "Proud to serve homeowners in the Fort Myers / Cape Coral area.", Icon: Home },
] as const;

export default async function PublicServiceAreaPage({ params }: PageProps) {
  const { slug } = await params;
  const site = await loadPublicSite(slug);
  if (!site) {
    return <PublicUnavailable title="Page unavailable" body="This business could not be found." />;
  }
  const phone = publicPhone(site.business.slug);
  const textHref = smsHref(phone);
  const requestHref = publicRequestPath(site.business.slug);

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(site.business.slug)}
          current="Service Area"
          title="Our Service Area."
          accent="Local. Reliable. Near You."
          description={SERVICE_AREA_COPY}
          imageSrc={PUBLIC_AREA_HERO_IMAGE}
          phone={phone}
          smsHref={textHref}
          requestHref={requestHref}
        />
        <section className="bg-[var(--public-paper)]">
          <div className="public-container grid gap-8 py-16 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.4fr)]">
            <div>
              <MapPin className="size-8 text-[var(--public-blue)]" />
              <h2 className="mt-4 text-2xl font-extrabold uppercase">Local Experts</h2>
              <p className="mt-4 text-muted-foreground">{SERVICE_AREA_COPY}</p>
              <ul className="mt-6 space-y-4">
                {POINTS.map((point) => (
                  <li key={point.title} className="flex gap-3">
                    <point.Icon className="mt-0.5 size-5 text-[var(--public-blue)]" />
                    <div>
                      <p className="font-extrabold">{point.title}</p>
                      <p className="text-sm text-muted-foreground">{point.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-lg bg-[#e8f1ff] p-6">
              <h2 className="text-xl font-extrabold uppercase">Our Service Areas</h2>
              <p className="mt-2 text-xs font-extrabold tracking-wide text-[var(--public-blue)] uppercase">
                Primary areas we serve
              </p>
              <ul className="mt-4 space-y-2 font-semibold">
                <li>Fort Myers</li>
                <li>Cape Coral</li>
                <li>And surrounding areas, confirmed by address</li>
              </ul>
              <div className="mt-6 rounded-md bg-white p-4">
                <p className="font-extrabold uppercase">Not sure if you&apos;re in our area?</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Just text us. We&apos;ll confirm service availability for your location.
                </p>
                {textHref ? (
                  <a href={textHref} className="mt-3 inline-block font-extrabold text-[var(--public-blue)]">
                    {TEXT_US_LABEL} {phone}
                  </a>
                ) : null}
              </div>
            </div>
            <div>
              <iframe
                title="Fort Myers and Cape Coral area map"
                className="public-map"
                src={SERVICE_AREA_MAP_SRC}
              />
              <p className="mt-3 text-sm text-muted-foreground">
                Map shows the Fort Myers / Cape Coral area. It is not an exact service-boundary guarantee.
              </p>
            </div>
          </div>
        </section>
        <PublicCtaBar
          title="Ready to get your project started?"
          body="Let's make it happen. We're here to help."
          requestHref={requestHref}
          smsHref={textHref}
          phone={phone}
        />
      </main>
    </PublicSiteShell>
  );
}

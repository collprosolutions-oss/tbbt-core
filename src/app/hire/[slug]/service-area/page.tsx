import type { Metadata } from "next";
import Image from "next/image";
import {
  Clock,
  Home,
  MapPin,
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
  PUBLIC_AREA_PHOTO,
  SERVICE_AREA_COPY,
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
  const name = site ? publicDisplayName(site.business) : "Service Area";
  return {
    title: { absolute: `Service Area | ${name}` },
    description: SERVICE_AREA_COPY,
  };
}

const TRUST_ICONS = [Clock, Shield, MessageSquare, Home] as const;

export default async function PublicServiceAreaPage({ params }: PageProps) {
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
  const callHref = telHref(phone);
  const requestHref = publicRequestPath(site.business.slug);

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(site.business.slug)}
          current="Service Area"
          title="Service Area"
          accent="Serving the Fort Myers / Cape Coral area"
          description={SERVICE_AREA_COPY}
        >
          <div className="mt-8 max-w-lg rounded-lg border border-white/20 bg-black/35 p-5">
            <div className="flex items-start gap-3">
              <MapPin className="mt-0.5 size-5 text-[var(--public-blue-soft)]" aria-hidden="true" />
              <p className="text-sm leading-6 text-white/90">
                Submit your project address and we will confirm service
                availability for your location.
              </p>
            </div>
          </div>
        </PublicPageHero>

        <section className="bg-[var(--public-paper)]">
          <div className="public-container grid items-center gap-8 py-16 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div className="public-side-card">
              <h2 className="text-2xl font-extrabold tracking-tight uppercase">
                Areas We Serve
              </h2>
              <p className="mt-4 text-base leading-7 text-muted-foreground">
                {SERVICE_AREA_COPY}
              </p>
              {callHref ? (
                <a href={callHref} className="public-btn public-btn-outline-blue mt-6">
                  Call {phone}
                </a>
              ) : null}
            </div>
            <div className="overflow-hidden rounded-lg bg-white shadow-[0_16px_40px_rgba(5,11,21,0.08)]">
              <div className="relative min-h-72">
                <Image
                  src={PUBLIC_AREA_PHOTO}
                  alt="Exterior carpentry completed in a Southwest Florida home setting"
                  fill
                  sizes="(max-width: 1024px) 100vw, 50vw"
                  className="object-cover"
                />
              </div>
              <div className="bg-[var(--public-navy)] px-5 py-4 text-white">
                <p className="font-bold">We come to you</p>
                <p className="mt-1 text-sm text-white/75">
                  Professional service at your location after we confirm the
                  address is in range.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="bg-[var(--public-navy)] text-white">
          <div className="public-container py-14">
            <h2 className="text-center text-2xl font-extrabold tracking-tight uppercase">
              Why Choose {name}?
            </h2>
            <div className="mt-10 grid gap-8 sm:grid-cols-2 xl:grid-cols-4">
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
          </div>
        </section>

        <PublicCtaBar
          title="Ready to get started?"
          body="Let's get your home project done right. Contact us today for a free quote."
          requestHref={requestHref}
          callHref={callHref}
          phone={phone}
        />
      </main>
    </PublicSiteShell>
  );
}

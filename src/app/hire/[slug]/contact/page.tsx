import type { Metadata } from "next";
import Image from "next/image";
import { MapPin, MessageSquare, Phone } from "lucide-react";
import "@/components/public/public-site.css";
import { PublicContactForm } from "@/components/public/public-contact-form";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { PublicUnavailable } from "@/components/public/public-unavailable";
import { telHref } from "@/lib/directions";
import {
  PUBLIC_CONTACT_PHOTO,
  SERVICE_AREA_COPY,
  popularPublicCategories,
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
  const name = site ? publicDisplayName(site.business) : "Contact";
  return {
    title: { absolute: `Contact Us | ${name}` },
    description: `Contact ${name} by phone or send a project request online.`,
  };
}

export default async function PublicContactPage({ params }: PageProps) {
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
  const categories = popularPublicCategories(site.groups, site.groups.length);

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(site.business.slug)}
          current="Contact Us"
          title="Contact Us"
          accent="We'd love to hear from you!"
          description={`Have a question or ready to start your project? Reach out to ${name} for fast, friendly service.`}
        />
        <section className="bg-[var(--public-paper)]">
          <div className="public-container grid gap-8 py-14 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.75fr)_minmax(0,0.75fr)]">
            <PublicContactForm slug={site.business.slug} categories={categories} />
            <div className="public-side-card">
              <h2 className="text-xl font-extrabold tracking-tight uppercase">
                Get In Touch
              </h2>
              <ul className="mt-6 space-y-5">
                {callHref ? (
                  <li className="flex gap-3">
                    <span className="public-icon-circle">
                      <Phone className="size-4" aria-hidden="true" />
                    </span>
                    <div>
                      <p className="text-sm font-bold uppercase tracking-wide">Call or Text</p>
                      <a href={callHref} className="text-lg font-bold text-[var(--public-navy)]">
                        {phone}
                      </a>
                    </div>
                  </li>
                ) : null}
                <li className="flex gap-3">
                  <span className="public-icon-circle">
                    <MapPin className="size-4" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="text-sm font-bold uppercase tracking-wide">Service Area</p>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {SERVICE_AREA_COPY}
                    </p>
                  </div>
                </li>
              </ul>
            </div>
            <aside className="public-side-card-dark">
              <div className="relative h-40">
                <Image
                  src={PUBLIC_CONTACT_PHOTO}
                  alt="Completed CollPro Reno interior project"
                  fill
                  sizes="(max-width: 1024px) 100vw, 25vw"
                  className="object-cover"
                />
              </div>
              <div className="p-5">
                <span className="public-icon-circle bg-[var(--public-blue)] text-white">
                  <MessageSquare className="size-4" aria-hidden="true" />
                </span>
                <h2 className="mt-4 text-xl font-extrabold uppercase">Prefer to talk?</h2>
                <p className="mt-3 text-sm leading-6 text-white/75">
                  Call or text and we will help you get the request started.
                </p>
                {callHref ? (
                  <a href={callHref} className="public-btn public-btn-ghost mt-5 w-full">
                    <Phone className="size-4" aria-hidden="true" />
                    Call {phone}
                  </a>
                ) : null}
              </div>
            </aside>
          </div>
        </section>
        <PublicCtaBar
          title="Ready to get started?"
          body="Let's bring your vision to life. Contact us today for a free, no-obligation estimate."
          requestHref={publicRequestPath(site.business.slug)}
          callHref={callHref}
          phone={phone}
        />
      </main>
    </PublicSiteShell>
  );
}

import type { Metadata } from "next";
import { Clock, MessageSquare, Shield } from "lucide-react";
import "@/components/public/public-site.css";
import { PublicContactForm } from "@/components/public/public-contact-form";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { PublicUnavailable } from "@/components/public/public-unavailable";
import { smsHref } from "@/lib/directions";
import {
  PUBLIC_CONTACT_HERO_IMAGE,
  SERVICE_AREA_COPY,
  TEXT_US_LABEL,
  popularPublicCategories,
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
  const name = site ? publicDisplayName(site.business) : "Contact";
  return {
    title: { absolute: `Contact Us | ${name}` },
    description: `Text ${name} at 239-357-8199 or send a project request online.`,
  };
}

export default async function PublicContactPage({ params }: PageProps) {
  const { slug } = await params;
  const site = await loadPublicSite(slug);
  if (!site) {
    return <PublicUnavailable title="Page unavailable" body="This business could not be found." />;
  }
  const phone = publicPhone(site.business.slug);
  const textHref = smsHref(phone);
  const categories = popularPublicCategories(site.groups, site.groups.length);

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(site.business.slug)}
          current="Contact Us"
          title={<>We&apos;re Here <em>To Help.</em></>}
          description="Have a question or need a quote? Text us your project details or send a message. We'll follow up."
          imageSrc={PUBLIC_CONTACT_HERO_IMAGE}
          phone={phone}
          smsHref={textHref}
          requestHref={publicRequestPath(site.business.slug)}
        >
          <PublicContactForm slug={site.business.slug} categories={categories} />
        </PublicPageHero>
        <section className="bg-white">
          <div className="public-container grid gap-8 py-10 md:grid-cols-3">
            <div className="text-center">
              <MessageSquare className="mx-auto size-7 text-[var(--public-blue)]" />
              <h2 className="mt-3 font-extrabold">Fast Response</h2>
              <p className="mt-2 text-sm text-muted-foreground">Text us about your project and we will follow up.</p>
            </div>
            <div className="text-center">
              <Shield className="mx-auto size-7 text-[var(--public-blue)]" />
              <h2 className="mt-3 font-extrabold">Dependable</h2>
              <p className="mt-2 text-sm text-muted-foreground">Your request becomes an organized project record.</p>
            </div>
            <div className="text-center">
              <Clock className="mx-auto size-7 text-[var(--public-blue)]" />
              <h2 className="mt-3 font-extrabold">Quality Work</h2>
              <p className="mt-2 text-sm text-muted-foreground">Quality-minded workmanship on the jobs we take on.</p>
            </div>
          </div>
        </section>
        <section className="bg-[var(--public-paper)]">
          <div className="public-container grid gap-10 py-16 md:grid-cols-2">
            <div>
              <h2 className="text-2xl font-extrabold uppercase">Get In Touch</h2>
              <p className="mt-6 text-xs font-extrabold tracking-wide uppercase">{TEXT_US_LABEL} (Preferred)</p>
              {textHref ? (
                <a href={textHref} className="mt-1 block text-2xl font-extrabold">
                  {phone}
                </a>
              ) : null}
              <p className="mt-3 max-w-md text-sm text-muted-foreground">
                Text project photos, the work you need, and your address. We will respond and follow up.
              </p>
              <p className="mt-6 text-xs font-extrabold tracking-wide uppercase">Service Area</p>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">{SERVICE_AREA_COPY}</p>
            </div>
            <div>
              <h2 className="text-2xl font-extrabold uppercase">Not sure if we service your area?</h2>
              <p className="mt-4 text-muted-foreground">
                Just text us — we&apos;ll let you know after we review your project address.
              </p>
            </div>
          </div>
        </section>
        <PublicCtaBar
          title="Have a project in mind?"
          body="Let's make it happen. We're here to help."
          requestHref={publicRequestPath(site.business.slug)}
          smsHref={textHref}
          phone={phone}
        />
      </main>
    </PublicSiteShell>
  );
}

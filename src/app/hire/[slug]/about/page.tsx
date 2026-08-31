import type { Metadata } from "next";
import Link from "next/link";
import "@/components/public/public-site.css";
import { PublicAbout } from "@/components/public/public-about";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import {
  PRIMARY_CTA_LABEL,
  publicDisplayName,
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
  const name = site ? publicDisplayName(site.business) : "About";
  return {
    title: { absolute: `About Us | ${name}` },
    description: `Learn how ${name} helps homeowners with handyman projects, written estimates, and organized requests.`,
  };
}

export default async function PublicAboutPage({ params }: PageProps) {
  const { slug } = await params;
  const site = await loadPublicSite(slug);

  if (!site) {
    return (
      <main className="public-site mx-auto flex min-h-full max-w-md items-center px-4 py-16">
        <div className="rounded-xl border border-border bg-white p-6">
          <h1 className="text-xl font-semibold">Page unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This business could not be found.
          </p>
        </div>
      </main>
    );
  }

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main className="bg-[var(--background)]">
        <div className="public-container py-14 lg:py-20">
          <PublicAbout />
          <div className="mt-10">
            <Link
              href={publicRequestPath(site.business.slug)}
              className="public-btn public-btn-primary"
            >
              {PRIMARY_CTA_LABEL}
            </Link>
          </div>
        </div>
      </main>
    </PublicSiteShell>
  );
}

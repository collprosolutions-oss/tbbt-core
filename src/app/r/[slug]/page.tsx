import type { Metadata } from "next";
import "@/components/public/public-site.css";
import { MultiServiceRequestFlow } from "@/components/public/request-flow";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import type { SelectedWorkState } from "@/components/public/service-picker";
import { publicDisplayName } from "@/lib/public-site";
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
      <main className="public-site mx-auto flex min-h-full max-w-md items-center px-4 py-16">
        <div className="rounded-xl border border-border bg-white p-6">
          <h1 className="text-xl font-semibold">Request unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This request could not be submitted.
          </p>
        </div>
      </main>
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

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <section className="bg-[var(--public-navy)] text-white">
          <div className="public-container py-10 lg:py-14">
            <p className="text-sm font-bold tracking-[0.18em] text-[var(--public-blue-soft)] uppercase">
              Request Service
            </p>
            <h1 className="mt-3 text-4xl font-extrabold tracking-tight sm:text-5xl">
              Request Service
            </h1>
            <p className="mt-4 max-w-3xl text-lg leading-8 text-white/80">
              Select one or more tasks for a single visit. {publicDisplayName(site.business)}{" "}
              will review your request before creating an estimate.
            </p>
          </div>
        </section>
        <div className="public-container py-10 lg:py-14">
          <MultiServiceRequestFlow
            slug={site.business.slug}
            businessName={publicDisplayName(site.business)}
            items={site.items}
            groups={site.groups}
            initialSelected={initialSelected}
            photosEnabled={isStorageConfigured()}
          />
        </div>
      </main>
    </PublicSiteShell>
  );
}

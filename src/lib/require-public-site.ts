import { notFound } from "next/navigation";
import { loadPublicWebsiteView, type PublicWebsiteView } from "@/lib/website-engine/public";
import type { PublicSitePayload } from "@/lib/public-site-data";

export async function requirePublicWebsiteView(slug: string): Promise<PublicWebsiteView> {
  const view = await loadPublicWebsiteView(slug);
  if (!view) notFound();
  return view;
}

export async function requirePublicSite(slug: string): Promise<PublicSitePayload> {
  const view = await requirePublicWebsiteView(slug);
  return view.site;
}

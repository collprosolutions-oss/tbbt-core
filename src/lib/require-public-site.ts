import { notFound } from "next/navigation";
import { loadPublicSite, type PublicSitePayload } from "@/lib/public-site-data";

export async function requirePublicSite(slug: string): Promise<PublicSitePayload> {
  const site = await loadPublicSite(slug);
  if (!site) notFound();
  return site;
}

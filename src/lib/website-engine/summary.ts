import type { PublishedWebsiteSnapshot } from "@/lib/website-engine/snapshot";

export function summarizeWebsiteSnapshotChange(
  previous: PublishedWebsiteSnapshot | null,
  next: PublishedWebsiteSnapshot,
) {
  if (!previous) {
    return `First publish · ${next.services.length} services · ${next.serviceAreas.length} service areas`;
  }
  const parts: string[] = [];
  const prevServices = new Set(previous.services.map((row) => row.id));
  const nextServices = new Set(next.services.map((row) => row.id));
  const added = [...nextServices].filter((id) => !prevServices.has(id)).length;
  const removed = [...prevServices].filter((id) => !nextServices.has(id)).length;
  if (added) parts.push(`${added} service${added === 1 ? "" : "s"} added`);
  if (removed) parts.push(`${removed} service${removed === 1 ? "" : "s"} removed`);
  if (previous.about.copy !== next.about.copy) parts.push("About updated");
  if (
    previous.home.headline !== next.home.headline ||
    previous.home.supporting !== next.home.supporting
  ) {
    parts.push("Homepage updated");
  }
  const prevAreas = new Set(previous.serviceAreas.map((row) => row.id));
  const nextAreas = new Set(next.serviceAreas.map((row) => row.id));
  const areasRemoved = [...prevAreas].filter((id) => !nextAreas.has(id)).length;
  if (areasRemoved) {
    parts.push(`${areasRemoved} service area${areasRemoved === 1 ? "" : "s"} removed`);
  }
  if (previous.gallery.length !== next.gallery.length) parts.push("gallery changed");
  if (previous.reviews.length !== next.reviews.length) parts.push("reviews changed");
  if (previous.trades.map((row) => row.code).join() !== next.trades.map((row) => row.code).join()) {
    parts.push("trades updated");
  }
  return parts.length > 0 ? parts.join(" · ") : "Website republished";
}

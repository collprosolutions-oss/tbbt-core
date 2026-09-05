/**
 * Per-business logo lookup.
 *
 * There is no `Business.logoUrl` column (no schema change was made for
 * this cosmetic pass), so a subscriber business's own logo is looked up
 * here by the business's own `slug`, entirely OUTSIDE the reusable
 * AppShell component -- unlike the TBBT platform mark (which every
 * business's shell shows unconditionally, since AppShell itself is a TBBT
 * component), a specific business's brand asset must never be hardcoded
 * into a shared component. AppShell only ever receives a plain
 * `businessLogoSrc?: string | null` prop and has no knowledge of any
 * particular business's name or logo.
 *
 * This map is the one place a new subscriber business's approved logo
 * gets wired in until a real `Business.logoUrl` field exists; a business
 * with no entry here simply renders AppShell's existing empty logo slot.
 *
 * BUG FIX: this previously only had "collpro-reno-handyman-services" (the
 * slug slugifyName()/allocateBusinessSlug() produces for a *freshly
 * signed-up* business named "CollPro Reno Handyman Services" -- see
 * src/lib/slug.ts). But prisma/migrations/
 * 20260824233202_set_collpro_reno_canonical_slug already renamed the
 * real, already-existing CollPro business's slug to the shorter
 * "collpro-reno" in every database that migration has run against
 * (including the deployed preview/production database) -- so the logo
 * lookup was silently missing on the actual deployed app even though it
 * worked against a fresh local database created via sign-up (which never
 * had that historical slug to rename). Both slugs are mapped here so
 * this resolves correctly regardless of which one a given database
 * currently has.
 */
const BUSINESS_LOGOS: Record<string, string> = {
  "collpro-reno": "/brand/collpro-logo.png",
  "collpro-reno-handyman-services": "/brand/collpro-logo.png",
};

/** Dark-background logo for the dashboard / public website. */
export function getBusinessLogoSrc(slug: string): string | null {
  return BUSINESS_LOGOS[slug] ?? null;
}

/**
 * Transparent-background logo for white invoice/PDF pages only.
 * Does not replace getBusinessLogoSrc() — dark UI keeps the original asset.
 */
const BUSINESS_DOCUMENT_LOGOS: Record<string, string> = {
  "collpro-reno": "/brand/collpro-logo-document.png",
  "collpro-reno-handyman-services": "/brand/collpro-logo-document.png",
};

export function getBusinessDocumentLogoSrc(slug: string): string | null {
  return BUSINESS_DOCUMENT_LOGOS[slug] ?? getBusinessLogoSrc(slug);
}

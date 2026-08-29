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
 */
const BUSINESS_LOGOS: Record<string, string> = {
  "collpro-reno-handyman-services": "/brand/collpro-logo.png",
};

export function getBusinessLogoSrc(slug: string): string | null {
  return BUSINESS_LOGOS[slug] ?? null;
}

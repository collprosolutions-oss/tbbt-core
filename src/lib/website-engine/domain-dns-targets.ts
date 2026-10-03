/**
 * Display and matching targets for OWNER custom-domain instructions.
 * These are not used for public routing and do not edit DNS.
 *
 * Apex A comes from the collpro-reno Vercel project: both verified
 * production apexes (collproreno.com, tbbtool.com) resolve to this
 * address. Vercel treats 76.76.21.21 as a general-purpose example;
 * this project's domain card uses the project-specific anycast IP.
 */
export const WEBSITE_DOMAIN_DNS_CNAME_TARGET = "cname.vercel-dns.com";

export const WEBSITE_DOMAIN_VERCEL_A_ADDRESSES = ["216.198.79.1"] as const;

export function websiteDomainApexATargetsLabel() {
  return WEBSITE_DOMAIN_VERCEL_A_ADDRESSES.join(" / ");
}

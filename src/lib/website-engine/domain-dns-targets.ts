/**
 * Read-only custom-domain DNS target table.
 *
 * Tenant-facing instructions use Vercel's documented general-purpose
 * records (and project-recommended values when configured). Matching
 * also accepts platform-observed CollPro/TBBT apex addresses so those
 * production hosts are not reported unverified. This module does not
 * call Vercel, edit DNS, or change public routing.
 */

export const WEBSITE_DOMAIN_DNS_CNAME_TARGET = "cname.vercel-dns.com";

export const VERCEL_GENERAL_PURPOSE_APEX_A = "76.76.21.21";

export const WEBSITE_DOMAIN_MAX_DNS_RECORDS = 8;

export type WebsiteDomainApexASource =
  | "vercel-general-purpose"
  | "project-recommended"
  | "platform-observed";

export type WebsiteDomainApexAAllowlistRow = {
  address: string;
  source: WebsiteDomainApexASource;
  tenantFacing: boolean;
  label: string;
};

const STATIC_APEX_A_ALLOWLIST: readonly WebsiteDomainApexAAllowlistRow[] = [
  {
    address: VERCEL_GENERAL_PURPOSE_APEX_A,
    source: "vercel-general-purpose",
    tenantFacing: true,
    label: "Vercel documented general-purpose apex A",
  },
  {
    address: "216.198.79.1",
    source: "platform-observed",
    tenantFacing: false,
    label: "Observed collproreno.com / tbbtool.com apex; not a tenant instruction",
  },
];

let injectedProjectRecommendedA: string[] | null = null;

export function setWebsiteDomainProjectRecommendedA(addresses: string[] | null) {
  injectedProjectRecommendedA = addresses === null ? null : [...addresses];
}

export function resetWebsiteDomainProjectRecommendedA() {
  injectedProjectRecommendedA = null;
}

function normalizeIpv4Candidate(value: string) {
  return value.trim().replace(/\.$/, "");
}

function projectRecommendedAddresses() {
  if (injectedProjectRecommendedA) {
    return injectedProjectRecommendedA.map(normalizeIpv4Candidate).filter(Boolean);
  }
  return (process.env.WEBSITE_DOMAIN_PROJECT_RECOMMENDED_A ?? "")
    .split(",")
    .map(normalizeIpv4Candidate)
    .filter(Boolean);
}

export function websiteDomainApexAAllowlist(): WebsiteDomainApexAAllowlistRow[] {
  const rows: WebsiteDomainApexAAllowlistRow[] = [];
  const seen = new Set<string>();
  const extras = projectRecommendedAddresses().map((address) => ({
    address,
    source: "project-recommended" as const,
    tenantFacing: true,
    label: "Project-specific Vercel Domains card A",
  }));
  for (const row of [...STATIC_APEX_A_ALLOWLIST, ...extras]) {
    if (seen.has(row.address)) continue;
    seen.add(row.address);
    rows.push(row);
  }
  return rows;
}

export function websiteDomainApexAMatchAddresses() {
  return websiteDomainApexAAllowlist().map((row) => row.address);
}

export function websiteDomainApexAInstructionAddresses() {
  return websiteDomainApexAAllowlist()
    .filter((row) => row.tenantFacing)
    .map((row) => row.address);
}

export function websiteDomainApexATargetsLabel() {
  return websiteDomainApexAInstructionAddresses().join(" / ");
}

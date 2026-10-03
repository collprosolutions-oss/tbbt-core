/**
 * Read-only custom-domain DNS target table.
 *
 * Tenant-facing instructions use Vercel's documented general-purpose
 * records (and a validated project-recommended public IPv4 when set).
 * Matching also accepts documented Vercel compatibility apex 76.76.21.22
 * and platform-observed CollPro/TBBT apex addresses so those hosts are
 * not reported unverified. This module does not call Vercel, edit DNS,
 * or change public routing.
 */

export const WEBSITE_DOMAIN_DNS_CNAME_TARGET = "cname.vercel-dns.com";

export const VERCEL_GENERAL_PURPOSE_APEX_A = "76.76.21.21";

/** Documented Vercel compatibility apex A. Match-only; never tenant-facing. */
export const VERCEL_GENERAL_PURPOSE_COMPAT_APEX_A = "76.76.21.22";

export const PLATFORM_OBSERVED_APEX_A = "216.198.79.1";

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
    address: VERCEL_GENERAL_PURPOSE_COMPAT_APEX_A,
    source: "vercel-general-purpose",
    tenantFacing: false,
    label: "Vercel documented compatibility apex A; not a tenant instruction",
  },
  {
    address: PLATFORM_OBSERVED_APEX_A,
    source: "platform-observed",
    tenantFacing: false,
    label: "Observed collproreno.com / tbbtool.com apex; not a tenant instruction",
  },
];

const STRICT_DOTTED_QUAD = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

type Ipv4Range = { base: [number, number, number, number]; bits: number };

const REJECTED_IPV4_RANGES: readonly Ipv4Range[] = [
  { base: [0, 0, 0, 0], bits: 8 },
  { base: [10, 0, 0, 0], bits: 8 },
  { base: [100, 64, 0, 0], bits: 10 },
  { base: [127, 0, 0, 0], bits: 8 },
  { base: [169, 254, 0, 0], bits: 16 },
  { base: [172, 16, 0, 0], bits: 12 },
  { base: [192, 0, 0, 0], bits: 24 },
  { base: [192, 0, 2, 0], bits: 24 },
  { base: [192, 88, 99, 0], bits: 24 },
  { base: [192, 168, 0, 0], bits: 16 },
  { base: [198, 18, 0, 0], bits: 15 },
  { base: [198, 51, 100, 0], bits: 24 },
  { base: [203, 0, 113, 0], bits: 24 },
  { base: [224, 0, 0, 0], bits: 4 },
  { base: [240, 0, 0, 0], bits: 4 },
];

function ipv4ToInt(octets: readonly number[]) {
  return (
    ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0
  );
}

function ipv4InRange(ip: number, range: Ipv4Range) {
  const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
  return (ip & mask) === (ipv4ToInt(range.base) & mask);
}

function isRejectedSpecialPurposeIpv4(octets: readonly number[]) {
  const ip = ipv4ToInt(octets);
  return REJECTED_IPV4_RANGES.some((range) => ipv4InRange(ip, range));
}

/**
 * Strict public IPv4 for WEBSITE_DOMAIN_PROJECT_RECOMMENDED_A.
 * Four decimal octets 0-255, no leading zeros, no whitespace or extra
 * text. Rejects private, loopback, link-local, CGNAT/shared, multicast,
 * reserved, broadcast, documentation, 0.0.0.0/8, IPv6, hostnames, CIDR,
 * URLs, and values with ports. Never throws.
 */
export function parseWebsiteDomainProjectRecommendedA(
  value: unknown,
): string | null {
  try {
    if (typeof value !== "string") return null;
    if (!STRICT_DOTTED_QUAD.test(value)) return null;
    const octets = value.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((octet) => octet > 255)) return null;
    if (isRejectedSpecialPurposeIpv4(octets)) return null;
    return value;
  } catch {
    return null;
  }
}

let injectedProjectRecommendedA: string[] | null = null;

export function setWebsiteDomainProjectRecommendedA(addresses: string[] | null) {
  injectedProjectRecommendedA = addresses === null ? null : [...addresses];
}

export function resetWebsiteDomainProjectRecommendedA() {
  injectedProjectRecommendedA = null;
}

function projectRecommendedAddresses() {
  try {
    const raw =
      injectedProjectRecommendedA ??
      (process.env.WEBSITE_DOMAIN_PROJECT_RECOMMENDED_A ?? "").split(",");
    const unique = new Set<string>();
    for (const value of raw) {
      const parsed = parseWebsiteDomainProjectRecommendedA(value);
      if (parsed) unique.add(parsed);
    }
    return [...unique];
  } catch {
    return [];
  }
}

export function websiteDomainApexAAllowlist(): WebsiteDomainApexAAllowlistRow[] {
  try {
    const byAddress = new Map<string, WebsiteDomainApexAAllowlistRow>();
    for (const row of STATIC_APEX_A_ALLOWLIST) {
      byAddress.set(row.address, { ...row });
    }
    for (const address of projectRecommendedAddresses()) {
      byAddress.set(address, {
        address,
        source: "project-recommended",
        tenantFacing: true,
        label: "Project-specific Vercel Domains card A",
      });
    }
    return [...byAddress.values()].sort((left, right) => {
      if (left.address === VERCEL_GENERAL_PURPOSE_APEX_A) return -1;
      if (right.address === VERCEL_GENERAL_PURPOSE_APEX_A) return 1;
      if (left.tenantFacing !== right.tenantFacing) {
        return left.tenantFacing ? -1 : 1;
      }
      return 0;
    });
  } catch {
    return STATIC_APEX_A_ALLOWLIST.map((row) => ({ ...row }));
  }
}

export function websiteDomainApexAMatchAddresses() {
  return websiteDomainApexAAllowlist().map((row) => row.address);
}

export function websiteDomainApexAInstructionAddresses() {
  const addresses = websiteDomainApexAAllowlist()
    .filter((row) => row.tenantFacing)
    .map((row) => row.address);
  return addresses.length > 0 ? addresses : [VERCEL_GENERAL_PURPOSE_APEX_A];
}

export function websiteDomainApexATargetsLabel() {
  try {
    return websiteDomainApexAInstructionAddresses().join(" / ") || VERCEL_GENERAL_PURPOSE_APEX_A;
  } catch {
    return VERCEL_GENERAL_PURPOSE_APEX_A;
  }
}

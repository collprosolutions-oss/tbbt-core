/**
 * Read-only custom-domain verification for one business.
 *
 * Reuses WebsiteHostBinding. Looks up DNS and host ownership against
 * that business and its published site. Never writes DNS, never
 * publishes, and never treats a typed publicWebsite URL as connected.
 *
 * Tests inject fake DNS through setWebsiteDomainDnsLookup().
 */
import { resolve4, resolveCname } from "node:dns/promises";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import { getAppUrl } from "@/lib/mail";
import { firstHeaderHost } from "@/lib/vercel-app-host";
import {
  WEBSITE_DOMAIN_DNS_CNAME_TARGET,
  WEBSITE_DOMAIN_VERCEL_A_ADDRESSES,
} from "@/lib/website-engine/domain-dns-targets";

export {
  WEBSITE_DOMAIN_DNS_CNAME_TARGET,
  WEBSITE_DOMAIN_VERCEL_A_ADDRESSES,
  websiteDomainApexATargetsLabel,
} from "@/lib/website-engine/domain-dns-targets";

export function normalizeHostname(host: string | null | undefined) {
  return (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

export function hostnameFromPublicWebsite(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  try {
    return normalizeHostname(new URL(trimmed).hostname) || null;
  } catch {
    return normalizeHostname(trimmed) || null;
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

export const WEBSITE_DOMAIN_DNS_LOOKUP_TIMEOUT_MS = 3000;

const VERCEL_PROJECT_DNS_CNAME = /^[a-z0-9-]+\.vercel-dns-\d+\.com$/;

export const WEBSITE_DOMAIN_VERIFICATION_STATES = [
  "NOT_CONFIGURED",
  "PENDING",
  "UNVERIFIED",
  "FAILED",
  "VERIFIED",
] as const;
export type WebsiteDomainVerificationState =
  (typeof WEBSITE_DOMAIN_VERIFICATION_STATES)[number];

export const WEBSITE_DOMAIN_VERIFICATION_LABELS: Record<
  WebsiteDomainVerificationState,
  string
> = {
  NOT_CONFIGURED: "Not configured",
  PENDING: "Pending",
  UNVERIFIED: "Unverified",
  FAILED: "Failed",
  VERIFIED: "Verified",
};

export type WebsiteDomainDnsRecords = {
  cnames: string[];
  addresses: string[];
};

export type WebsiteDomainDnsLookup = (hostname: string) => Promise<WebsiteDomainDnsRecords>;

const RETRYABLE_DNS_CODES = new Set([
  "ETIMEOUT",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ESERVFAIL",
  "EAI_AGAIN",
  "ECANCELLED",
  "EREFUSED",
]);

const EMPTY_DNS_CODES = new Set(["ENOTFOUND", "ENODATA", "ENOTIMP", "ENOENT"]);

function dnsErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: string }).code ?? "");
  }
  return "";
}

function normalizeDnsName(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

async function lookupRecordList(
  lookup: () => Promise<string[]>,
): Promise<string[]> {
  try {
    return (await lookup()).map(normalizeDnsName).filter(Boolean);
  } catch (error) {
    const code = dnsErrorCode(error);
    if (EMPTY_DNS_CODES.has(code)) return [];
    throw error;
  }
}

async function withDnsTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("DNS lookup timed out");
      (error as { code?: string }).code = "ETIMEOUT";
      reject(error);
    }, WEBSITE_DOMAIN_DNS_LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type WebsiteDomainNativeDnsResolvers = {
  resolveCname: (hostname: string) => Promise<string[]>;
  resolve4: (hostname: string) => Promise<string[]>;
};

export async function defaultWebsiteDomainDnsLookup(
  hostname: string,
  resolvers: Partial<WebsiteDomainNativeDnsResolvers> = {},
): Promise<WebsiteDomainDnsRecords> {
  const host = normalizeHostname(hostname);
  if (!host) return { cnames: [], addresses: [] };
  const lookupCname = resolvers.resolveCname ?? resolveCname;
  const lookup4 = resolvers.resolve4 ?? resolve4;
  return withDnsTimeout(
    Promise.all([
      lookupRecordList(() => lookupCname(host)),
      lookupRecordList(() => lookup4(host)),
    ]).then(([cnames, addresses]) => ({ cnames, addresses })),
  );
}

let injectedDnsLookup: WebsiteDomainDnsLookup | null = null;

export function setWebsiteDomainDnsLookup(lookup: WebsiteDomainDnsLookup | null) {
  injectedDnsLookup = lookup;
}

export function resetWebsiteDomainDnsLookup() {
  injectedDnsLookup = null;
}

export function getWebsiteDomainDnsLookup(): WebsiteDomainDnsLookup {
  return injectedDnsLookup ?? defaultWebsiteDomainDnsLookup;
}

export function expectedWebsiteDomainCnameTargets() {
  const targets = new Set<string>([WEBSITE_DOMAIN_DNS_CNAME_TARGET]);
  for (const raw of [
    getAppUrl(),
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ]) {
    const host = firstHeaderHost(raw ?? "");
    if (host) targets.add(normalizeDnsName(host));
  }
  return [...targets];
}

export function isVercelDnsCname(value: string) {
  const host = normalizeDnsName(value);
  if (!host) return false;
  if (host === WEBSITE_DOMAIN_DNS_CNAME_TARGET || host.endsWith(".vercel-dns.com")) {
    return true;
  }
  return VERCEL_PROJECT_DNS_CNAME.test(host);
}

export function isVercelApexAddress(value: string) {
  return (WEBSITE_DOMAIN_VERCEL_A_ADDRESSES as readonly string[]).includes(value.trim());
}

function cnamePointsAtTbbt(value: string) {
  const host = normalizeDnsName(value);
  if (!host) return false;
  if (isVercelDnsCname(host)) return true;
  return expectedWebsiteDomainCnameTargets().some(
    (target) => host === target || host.endsWith(`.${target}`),
  );
}

export function dnsRecordsPointAtTbbt(records: WebsiteDomainDnsRecords) {
  const cnames = records.cnames.map(normalizeDnsName).filter(Boolean);
  const addresses = records.addresses.map((address) => address.trim()).filter(Boolean);
  if (cnames.length === 0 && addresses.length === 0) return false;
  if (cnames.length > 0 && !cnames.every((cname) => cnamePointsAtTbbt(cname))) {
    return false;
  }
  if (addresses.length > 0 && !addresses.every((address) => isVercelApexAddress(address))) {
    return false;
  }
  return true;
}

export type WebsiteDomainVerification = {
  hostname: string | null;
  enteredWebsiteHostname: string | null;
  state: WebsiteDomainVerificationState;
  label: string;
  detail: string;
  publishedSite: boolean;
  bindingStatus: string | null;
  bindingBusinessId: string | null;
  readOnly: true;
};

function verification(input: {
  hostname: string | null;
  enteredWebsiteHostname: string | null;
  state: WebsiteDomainVerificationState;
  detail: string;
  publishedSite: boolean;
  bindingStatus: string | null;
  bindingBusinessId: string | null;
}): WebsiteDomainVerification {
  return {
    ...input,
    label: WEBSITE_DOMAIN_VERIFICATION_LABELS[input.state],
    readOnly: true,
  };
}

async function readDnsRecords(hostname: string): Promise<
  | { ok: true; records: WebsiteDomainDnsRecords }
  | { ok: false; pending: true }
> {
  try {
    const records = await getWebsiteDomainDnsLookup()(hostname);
    return {
      ok: true,
      records: {
        cnames: records.cnames.map(normalizeDnsName).filter(Boolean),
        addresses: records.addresses.map(normalizeDnsName).filter(Boolean),
      },
    };
  } catch (error) {
    const code = dnsErrorCode(error);
    if (RETRYABLE_DNS_CODES.has(code) || !code) {
      return { ok: false, pending: true };
    }
    return { ok: false, pending: true };
  }
}

function classifyDns(records: WebsiteDomainDnsRecords): "match" | "mismatch" {
  if (dnsRecordsPointAtTbbt(records)) return "match";
  return "mismatch";
}

export async function verifyConfiguredWebsiteDomain(
  db: Db,
  businessId: string,
): Promise<WebsiteDomainVerification> {
  const business = await db.business.findFirst({
    where: { id: businessId },
    select: {
      id: true,
      publishedWebsiteId: true,
      publicWebsite: true,
      websiteHostBindings: {
        select: { hostname: true, status: true, businessId: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
      },
    },
  });
  if (!business || business.id !== businessId) {
    throw new ForbiddenError();
  }

  const publishedSite = Boolean(business.publishedWebsiteId);
  const enteredWebsiteHostname = hostnameFromPublicWebsite(business.publicWebsite);
  // Settings shows the newest binding. Go-live considers every binding.
  const binding = business.websiteHostBindings[0] ?? null;
  const hostname = binding?.hostname ? normalizeHostname(binding.hostname) : null;

  if (!hostname || !binding) {
    return verification({
      hostname: enteredWebsiteHostname,
      enteredWebsiteHostname,
      state: "NOT_CONFIGURED",
      detail: enteredWebsiteHostname
        ? `Website URL host ${enteredWebsiteHostname} is on file as contact text only. That is not a connected custom domain.`
        : "No custom-domain binding is on file. The public /hire site still works.",
      publishedSite,
      bindingStatus: null,
      bindingBusinessId: null,
    });
  }

  if (binding.businessId !== businessId) {
    return verification({
      hostname,
      enteredWebsiteHostname,
      state: "FAILED",
      detail: `Custom host ${hostname} is bound to another business and cannot be verified here.`,
      publishedSite,
      bindingStatus: binding.status,
      bindingBusinessId: binding.businessId,
    });
  }

  return verifyBoundHostname({
    hostname,
    status: binding.status,
    businessId: binding.businessId,
    business: {
      id: business.id,
      publishedWebsiteId: business.publishedWebsiteId,
      publicWebsite: business.publicWebsite,
    },
  });
}

export async function verifyHostnameForBusiness(
  db: Db,
  businessId: string,
  host: string | null | undefined,
): Promise<WebsiteDomainVerification> {
  const hostname = normalizeHostname(host);
  if (!hostname) {
    return verification({
      hostname: null,
      enteredWebsiteHostname: null,
      state: "NOT_CONFIGURED",
      detail: "No hostname was provided.",
      publishedSite: false,
      bindingStatus: null,
      bindingBusinessId: null,
    });
  }

  const binding = await db.websiteHostBinding.findFirst({
    where: { hostname },
    select: {
      hostname: true,
      status: true,
      businessId: true,
      business: { select: { id: true, publishedWebsiteId: true, publicWebsite: true } },
    },
  });
  if (!binding) {
    return verification({
      hostname,
      enteredWebsiteHostname: null,
      state: "FAILED",
      detail: `Host ${hostname} is unknown and is not bound to this business.`,
      publishedSite: false,
      bindingStatus: null,
      bindingBusinessId: null,
    });
  }
  if (binding.businessId !== businessId) {
    return verification({
      hostname,
      enteredWebsiteHostname: hostnameFromPublicWebsite(binding.business.publicWebsite),
      state: "FAILED",
      detail: `Host ${hostname} belongs to another business and cannot serve this site.`,
      publishedSite: Boolean(binding.business.publishedWebsiteId),
      bindingStatus: binding.status,
      bindingBusinessId: binding.businessId,
    });
  }
  return verifyBoundHostname(binding);
}

async function verifyBoundHostname(binding: {
  hostname: string;
  status: string;
  businessId: string;
  business: { id: string; publishedWebsiteId: string | null; publicWebsite: string | null };
}): Promise<WebsiteDomainVerification> {
  const hostname = normalizeHostname(binding.hostname);
  const enteredWebsiteHostname = hostnameFromPublicWebsite(binding.business.publicWebsite);
  const publishedSite = Boolean(binding.business.publishedWebsiteId);

  const dns = await readDnsRecords(hostname);
  if (!dns.ok) {
    return verification({
      hostname,
      enteredWebsiteHostname,
      state: "PENDING",
      detail: `Custom host ${hostname} verification is Pending because DNS/host ownership could not be completed.`,
      publishedSite,
      bindingStatus: binding.status,
      bindingBusinessId: binding.businessId,
    });
  }

  const dnsState = classifyDns(dns.records);
  if (dnsState === "mismatch") {
    return verification({
      hostname,
      enteredWebsiteHostname,
      state: "FAILED",
      detail: `Custom host ${hostname} does not point at this business's TBBT site.`,
      publishedSite,
      bindingStatus: binding.status,
      bindingBusinessId: binding.businessId,
    });
  }
  if (!publishedSite) {
    return verification({
      hostname,
      enteredWebsiteHostname,
      state: "PENDING",
      detail: `Custom host ${hostname} DNS matches TBBT, but verification is Pending until this business has a published site.`,
      publishedSite,
      bindingStatus: binding.status,
      bindingBusinessId: binding.businessId,
    });
  }
  if (binding.status !== "VERIFIED") {
    return verification({
      hostname,
      enteredWebsiteHostname,
      state: "UNVERIFIED",
      detail: `Custom host ${hostname} DNS matches TBBT, but the host binding is still unverified and does not route.`,
      publishedSite,
      bindingStatus: binding.status,
      bindingBusinessId: binding.businessId,
    });
  }

  return verification({
    hostname,
    enteredWebsiteHostname,
    state: "VERIFIED",
    detail: `Custom host ${hostname} is verified for this business's published site.`,
    publishedSite,
    bindingStatus: binding.status,
    bindingBusinessId: binding.businessId,
  });
}

export async function loadWebsiteDomainVerification(
  db: Db,
  access: Pick<BusinessAccess, "businessId" | "workspace">,
): Promise<WebsiteDomainVerification> {
  requireBusinessRole(access as BusinessAccess, "OWNER");
  if (access.workspace.business?.id && access.workspace.business.id !== access.businessId) {
    throw new ForbiddenError();
  }
  return verifyConfiguredWebsiteDomain(db, access.businessId);
}

export function goLiveDomainFromVerification(
  verification: WebsiteDomainVerification,
): {
  verifiedHostname: string | null;
  unverifiedHostname: string | null;
  failedHostname: string | null;
  pendingHostname: string | null;
} {
  const hostname = verification.hostname;
  if (verification.state === "VERIFIED") {
    return {
      verifiedHostname: hostname,
      unverifiedHostname: null,
      failedHostname: null,
      pendingHostname: null,
    };
  }
  if (verification.state === "PENDING") {
    return {
      verifiedHostname: null,
      unverifiedHostname: null,
      failedHostname: null,
      pendingHostname: hostname,
    };
  }
  if (verification.state === "FAILED") {
    return {
      verifiedHostname: null,
      unverifiedHostname: null,
      failedHostname: hostname,
      pendingHostname: null,
    };
  }
  if (verification.state === "UNVERIFIED") {
    return {
      verifiedHostname: null,
      unverifiedHostname: hostname,
      failedHostname: null,
      pendingHostname: null,
    };
  }
  return {
    verifiedHostname: null,
    unverifiedHostname: null,
    failedHostname: null,
    pendingHostname: null,
  };
}

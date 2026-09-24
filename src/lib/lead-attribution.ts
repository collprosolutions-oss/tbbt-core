/**
 * Recorded lead-source and campaign attribution.
 *
 * Never invents a source. Historical requests without leadSource stay
 * unattributed. First-touch customer source is written once.
 */

export const LEAD_SOURCES = [
  "WEBSITE",
  "REFERRAL",
  "CAMPAIGN",
  "MANUAL",
  "GOOGLE",
  "FACEBOOK",
  "OTHER",
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  WEBSITE: "Public website",
  REFERRAL: "Referral",
  CAMPAIGN: "Campaign",
  MANUAL: "Manual / owner entered",
  GOOGLE: "Google",
  FACEBOOK: "Facebook",
  OTHER: "Other",
};

export const PUBLIC_DEFAULT_LEAD_SOURCE: LeadSource = "WEBSITE";
export const OWNER_DEFAULT_LEAD_SOURCE: LeadSource = "MANUAL";

export function isLeadSource(value: string | null | undefined): value is LeadSource {
  return Boolean(value && (LEAD_SOURCES as readonly string[]).includes(value));
}

export function parseLeadSource(
  raw: string | null | undefined,
  fallback: LeadSource | null = null,
): LeadSource | null {
  const value = raw?.trim().toUpperCase() ?? "";
  if (isLeadSource(value)) return value;
  return fallback;
}

export function leadSourceLabel(value: string | null | undefined): string {
  if (isLeadSource(value)) return LEAD_SOURCE_LABELS[value];
  return "Not recorded";
}

export const CAMPAIGN_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "COMPLETED"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  PAUSED: "Paused",
  COMPLETED: "Completed",
};

export function isCampaignStatus(value: string): value is CampaignStatus {
  return (CAMPAIGN_STATUSES as readonly string[]).includes(value);
}

export function nextCampaignStatus(current: string): CampaignStatus | null {
  if (current === "DRAFT") return "ACTIVE";
  if (current === "ACTIVE") return "PAUSED";
  if (current === "PAUSED") return "ACTIVE";
  return null;
}

export type AttributionSnapshot = {
  leadSource: LeadSource | null;
  campaignId: string | null;
};

/** Copy recorded attribution onto a later record. Never invents values. */
export function copyAttribution(source: {
  leadSource?: string | null;
  campaignId?: string | null;
}): AttributionSnapshot {
  return {
    leadSource: parseLeadSource(source.leadSource),
    campaignId: source.campaignId ?? null,
  };
}

export function firstTouchAttribution(existing: AttributionSnapshot, incoming: AttributionSnapshot) {
  return {
    leadSource: existing.leadSource ?? incoming.leadSource,
    campaignId: existing.campaignId ?? incoming.campaignId,
  };
}

export type AttributionRow = {
  source: string;
  campaignId: string | null;
  campaignName: string | null;
  requests: number;
  estimates: number;
  jobs: number;
  paidRevenue: number;
};

export function rollupAttribution(input: {
  requests: Array<{ leadSource: string | null; campaignId: string | null }>;
  estimates: Array<{ leadSource: string | null; campaignId: string | null }>;
  jobs: Array<{
    leadSource: string | null;
    campaignId: string | null;
    paidRevenue: number;
  }>;
  campaigns: Array<{ id: string; name: string }>;
}): AttributionRow[] {
  const campaignName = new Map(input.campaigns.map((row) => [row.id, row.name]));
  const keys = new Map<string, AttributionRow>();

  function bucket(leadSource: string | null, campaignId: string | null) {
    const source = parseLeadSource(leadSource) ?? "UNRECORDED";
    const key = `${source}:${campaignId ?? ""}`;
    const existing = keys.get(key);
    if (existing) return existing;
    const created: AttributionRow = {
      source,
      campaignId,
      campaignName: campaignId ? campaignName.get(campaignId) ?? null : null,
      requests: 0,
      estimates: 0,
      jobs: 0,
      paidRevenue: 0,
    };
    keys.set(key, created);
    return created;
  }

  for (const row of input.requests) bucket(row.leadSource, row.campaignId).requests += 1;
  for (const row of input.estimates) bucket(row.leadSource, row.campaignId).estimates += 1;
  for (const row of input.jobs) {
    const item = bucket(row.leadSource, row.campaignId);
    item.jobs += 1;
    item.paidRevenue += row.paidRevenue;
  }

  return [...keys.values()].sort((a, b) => b.paidRevenue - a.paidRevenue || b.requests - a.requests);
}

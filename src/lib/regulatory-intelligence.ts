/**
 * Narrow read-only regulatory intelligence domain.
 *
 * Records jurisdiction, trade, official source URL, retrieval date,
 * effective/expiry dates, and an explicit UNKNOWN state. Stale,
 * conflicting, or missing information never certifies a license or
 * declares legal compliance. This slice does not claim nationwide
 * coverage and does not gate estimates or jobs.
 */
import type { MembershipRole } from "@prisma/client";
import { ForbiddenError, canAccessManagementConsole } from "@/lib/authorization";

export const REGULATORY_STATES = ["CURRENT", "STALE", "CONFLICT", "UNKNOWN"] as const;
export type RegulatoryState = (typeof REGULATORY_STATES)[number];

export const REGULATORY_STATE_LABELS: Record<RegulatoryState, string> = {
  CURRENT: "Current official-source note",
  STALE: "Stale official-source note",
  CONFLICT: "Conflicting official-source notes",
  UNKNOWN: "Unknown",
};

export const REGULATORY_FRESHNESS_DAYS = 180;

export const NEVER_CERTIFIES_LICENSE_MESSAGE =
  "This slice never certifies a license. A CURRENT official-source note is still not a license determination for any business, person, or job.";

export const NEVER_DECLARES_COMPLIANCE_MESSAGE =
  "This slice never declares legal compliance. Stale, conflicting, or missing information stays uncertified.";

export const NO_NATIONWIDE_COVERAGE_MESSAGE =
  "This slice does not claim nationwide coverage. One researched Florida / Lee County citation is not a national license map.";

export const DOES_NOT_GATE_WORK_MESSAGE =
  "Regulatory intelligence does not gate estimates or jobs. UNKNOWN, STALE, and CONFLICT never block creating or sending work.";

export const NOT_A_LICENSING_AUTHORITY_MESSAGE =
  "TBBT is not a licensing authority and does not replace Lee County Contractor Licensing, the Florida Department of Business and Professional Regulation, or counsel.";

export type RegulatoryNoteInput = {
  jurisdictionCode: string;
  jurisdictionLabel: string;
  tradeCode: string;
  officialSourceUrl: string;
  officialSourceTitle: string;
  citation: string;
  retrievedAt: Date | null;
  effectiveOn: Date | null;
  expiresOn: Date | null;
  recordedState: string;
  summary: string;
};

export type RegulatoryDecision = {
  state: RegulatoryState;
  certifiesLicense: false;
  declaresLegalCompliance: false;
  gatesEstimates: false;
  gatesJobs: false;
  claimsNationwideCoverage: false;
  reason: string;
};

export function isRegulatoryState(value: string | undefined): value is RegulatoryState {
  return (REGULATORY_STATES as readonly string[]).includes(value ?? "");
}

export function utcCalendarDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function hasRequiredFields(note: RegulatoryNoteInput): boolean {
  return Boolean(
    note.jurisdictionCode.trim() &&
      note.tradeCode.trim() &&
      note.officialSourceUrl.trim() &&
      note.retrievedAt instanceof Date &&
      !Number.isNaN(note.retrievedAt.getTime()),
  );
}

export function classifyRegulatoryNote(
  note: RegulatoryNoteInput,
  now: Date = new Date(),
): RegulatoryState {
  if (!hasRequiredFields(note)) return "UNKNOWN";
  if (note.recordedState === "UNKNOWN") return "UNKNOWN";
  if (note.recordedState === "CONFLICT") return "CONFLICT";

  const retrievedAt = note.retrievedAt as Date;
  const freshnessMs = REGULATORY_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
  if (now.getTime() - retrievedAt.getTime() > freshnessMs) return "STALE";
  if (note.expiresOn && utcCalendarDate(note.expiresOn) < utcCalendarDate(now)) return "STALE";
  if (note.recordedState === "STALE") return "STALE";
  return "CURRENT";
}

function sourceKey(note: RegulatoryNoteInput): string {
  return `${note.officialSourceUrl.trim()}::${note.citation.trim()}`;
}

export function resolveRegulatoryLookup(
  notes: readonly RegulatoryNoteInput[],
  now: Date = new Date(),
): RegulatoryDecision {
  if (notes.length === 0) {
    return regulatoryDecision("UNKNOWN", "No matching official-source note is on file for this jurisdiction and trade.");
  }

  const classified = notes.map((note) => classifyRegulatoryNote(note, now));
  const uniqueSources = new Set(notes.map(sourceKey));
  if (uniqueSources.size > 1) {
    return regulatoryDecision(
      "CONFLICT",
      "Matching notes cite different official sources or citations. Conflicting information never certifies a license.",
    );
  }
  if (classified.includes("CONFLICT")) {
    return regulatoryDecision("CONFLICT", "A matching note is recorded as CONFLICT. Conflicting information never certifies a license.");
  }
  if (classified.includes("UNKNOWN")) {
    return regulatoryDecision("UNKNOWN", "A matching note is missing required fields or is recorded as UNKNOWN.");
  }
  if (classified.includes("STALE") && classified.includes("CURRENT")) {
    return regulatoryDecision("CONFLICT", "Matching notes disagree on freshness. Mixed stale and current notes never certify a license.");
  }
  if (classified.every((state) => state === "STALE")) {
    return regulatoryDecision("STALE", "The matching official-source note is stale. Stale information never certifies a license.");
  }
  if (classified.every((state) => state === "CURRENT")) {
    return regulatoryDecision(
      "CURRENT",
      "An official-source note is current for this jurisdiction and trade. Current is not a license certification.",
    );
  }
  return regulatoryDecision("UNKNOWN", "The matching official-source note cannot be classified from the recorded fields.");
}

export function regulatoryDecision(state: RegulatoryState, reason: string): RegulatoryDecision {
  return {
    state,
    certifiesLicense: false,
    declaresLegalCompliance: false,
    gatesEstimates: false,
    gatesJobs: false,
    claimsNationwideCoverage: false,
    reason,
  };
}

export function shouldGateEstimatesOrJobs(_decision: RegulatoryDecision | RegulatoryState | null): false {
  return false;
}

export function claimsNationwideCoverage(): false {
  return false;
}

export function assertCanReadRegulatoryIntelligence(role: MembershipRole): void {
  if (!canAccessManagementConsole(role)) {
    throw new ForbiddenError();
  }
}

export function parseRegulatoryLookupQuery(raw: {
  jurisdiction?: string;
  trade?: string;
}): { jurisdictionCode: string | null; tradeCode: string | null } {
  const jurisdictionCode = raw.jurisdiction?.trim().toUpperCase() || null;
  const tradeCode = raw.trade?.trim().toUpperCase() || null;
  return { jurisdictionCode, tradeCode };
}

export function noteMatchesLookup(
  note: Pick<RegulatoryNoteInput, "jurisdictionCode" | "tradeCode">,
  lookup: { jurisdictionCode: string | null; tradeCode: string | null },
): boolean {
  if (lookup.jurisdictionCode && note.jurisdictionCode !== lookup.jurisdictionCode) return false;
  if (lookup.tradeCode && note.tradeCode !== lookup.tradeCode) return false;
  return Boolean(lookup.jurisdictionCode || lookup.tradeCode);
}

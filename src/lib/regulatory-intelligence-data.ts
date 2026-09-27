/**
 * Tenant-scoped read-only loader for regulatory intelligence notes.
 * Every query is keyed by the authenticated workspace businessId.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  catalogNoteMatchesLookup,
  leeCountyHandymanCatalogNote,
} from "@/lib/regulatory-intelligence-catalog";
import {
  assertCanReadRegulatoryIntelligence,
  classifyRegulatoryNote,
  noteMatchesLookup,
  parseRegulatoryLookupQuery,
  resolveRegulatoryLookup,
  type RegulatoryDecision,
  type RegulatoryNoteInput,
  type RegulatoryState,
} from "@/lib/regulatory-intelligence";

export type RegulatoryNoteView = RegulatoryNoteInput & {
  id: string;
  origin: "TENANT" | "CATALOG";
  classifiedState: RegulatoryState;
};

export type RegulatoryIntelligenceSource = {
  lookup: { jurisdictionCode: string | null; tradeCode: string | null };
  catalogExample: RegulatoryNoteView;
  tenantNotes: RegulatoryNoteView[];
  matchingNotes: RegulatoryNoteView[];
  decision: RegulatoryDecision;
};

function toTenantView(
  row: {
    id: string;
    jurisdictionCode: string;
    jurisdictionLabel: string;
    tradeCode: string;
    officialSourceUrl: string;
    officialSourceTitle: string;
    citation: string;
    retrievedAt: Date;
    effectiveOn: Date | null;
    expiresOn: Date | null;
    recordedState: string;
    summary: string;
  },
  now: Date,
): RegulatoryNoteView {
  const input: RegulatoryNoteInput = {
    jurisdictionCode: row.jurisdictionCode,
    jurisdictionLabel: row.jurisdictionLabel,
    tradeCode: row.tradeCode,
    officialSourceUrl: row.officialSourceUrl,
    officialSourceTitle: row.officialSourceTitle,
    citation: row.citation,
    retrievedAt: row.retrievedAt,
    effectiveOn: row.effectiveOn,
    expiresOn: row.expiresOn,
    recordedState: row.recordedState,
    summary: row.summary,
  };
  return {
    ...input,
    id: row.id,
    origin: "TENANT",
    classifiedState: classifyRegulatoryNote(input, now),
  };
}

export async function loadRegulatoryIntelligence(
  db: PrismaClient,
  access: Pick<BusinessAccess, "businessId" | "workspace">,
  rawQuery: { jurisdiction?: string; trade?: string } = {},
  now: Date = new Date(),
): Promise<RegulatoryIntelligenceSource> {
  assertCanReadRegulatoryIntelligence(access.workspace.role);

  const lookup = parseRegulatoryLookupQuery(rawQuery);
  const rows = await db.regulatoryIntelligenceNote.findMany({
    where: { businessId: access.businessId },
    orderBy: [{ retrievedAt: "desc" }, { id: "asc" }],
  });

  const catalog = leeCountyHandymanCatalogNote();
  const catalogExample: RegulatoryNoteView = {
    ...catalog,
    id: "catalog:US-FL-LEE:HANDYMAN",
    origin: "CATALOG",
    classifiedState: classifyRegulatoryNote(catalog, now),
  };

  const tenantNotes = rows.map((row) => toTenantView(row, now));
  const matchingTenant = lookup.jurisdictionCode || lookup.tradeCode
    ? tenantNotes.filter((note) => noteMatchesLookup(note, lookup))
    : [];
  const matchingNotes = [
    ...matchingTenant,
    ...(catalogNoteMatchesLookup(lookup) ? [catalogExample] : []),
  ];

  return {
    lookup,
    catalogExample,
    tenantNotes,
    matchingNotes,
    decision: resolveRegulatoryLookup(matchingNotes, now),
  };
}

import {
  DOES_NOT_GATE_WORK_MESSAGE,
  NEVER_CERTIFIES_LICENSE_MESSAGE,
  NEVER_DECLARES_COMPLIANCE_MESSAGE,
  NOT_A_LICENSING_AUTHORITY_MESSAGE,
  NO_NATIONWIDE_COVERAGE_MESSAGE,
  REGULATORY_STATE_LABELS,
  utcCalendarDate,
  type RegulatoryState,
} from "@/lib/regulatory-intelligence";
import {
  FLORIDA_DBPR_CONSTRUCTION_FAQ_URL,
  FLORIDA_STATUTE_489_103_URL,
  LEE_COUNTY_ORDINANCE_23_09_URL,
} from "@/lib/regulatory-intelligence-catalog";
import type { RegulatoryIntelligenceSource, RegulatoryNoteView } from "@/lib/regulatory-intelligence-data";

function stateClass(state: RegulatoryState): string {
  if (state === "CURRENT") return "border-border bg-muted/40 text-foreground";
  if (state === "STALE") return "border-amber-700/40 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100";
  if (state === "CONFLICT") return "border-red-700/40 bg-red-50 text-red-950 dark:bg-red-950/30 dark:text-red-100";
  return "border-border bg-background text-muted-foreground";
}

function NoteCard({ note }: { note: RegulatoryNoteView }) {
  return (
    <article className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-foreground">{note.officialSourceTitle}</h3>
          <p className="text-sm text-muted-foreground">
            {note.jurisdictionLabel} · {note.tradeCode}
            {note.origin === "CATALOG" ? " · Researched catalog citation" : " · Tenant-recorded note"}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${stateClass(note.classifiedState)}`}>
          {REGULATORY_STATE_LABELS[note.classifiedState]}
        </span>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Official source</dt>
          <dd>
            <a href={note.officialSourceUrl} className="break-all text-foreground underline underline-offset-2" target="_blank" rel="noreferrer">
              {note.officialSourceUrl}
            </a>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Retrieved</dt>
          <dd>{utcCalendarDate(note.retrievedAt as Date)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Effective</dt>
          <dd>{note.effectiveOn ? utcCalendarDate(note.effectiveOn) : "UNKNOWN — no effective date recorded"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Expiry</dt>
          <dd>{note.expiresOn ? utcCalendarDate(note.expiresOn) : "UNKNOWN — no expiry date recorded"}</dd>
        </div>
      </dl>
      <p className="text-sm leading-6 text-foreground">{note.summary}</p>
      <p className="text-xs leading-5 text-muted-foreground">Citation: {note.citation}</p>
    </article>
  );
}

export function RegulatoryIntelligenceWorkspace({ source }: { source: RegulatoryIntelligenceSource }) {
  return (
    <div className="space-y-6">
      <section className="space-y-2 rounded-xl border border-border bg-muted/30 p-4 text-sm leading-6 text-foreground">
        <p>{NOT_A_LICENSING_AUTHORITY_MESSAGE}</p>
        <p>{NEVER_CERTIFIES_LICENSE_MESSAGE}</p>
        <p>{NEVER_DECLARES_COMPLIANCE_MESSAGE}</p>
        <p>{NO_NATIONWIDE_COVERAGE_MESSAGE}</p>
        <p>{DOES_NOT_GATE_WORK_MESSAGE}</p>
      </section>

      <form method="get" action="/regulatory-intelligence" className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Jurisdiction</span>
          <input
            name="jurisdiction"
            defaultValue={source.lookup.jurisdictionCode ?? ""}
            placeholder="US-FL-LEE"
            className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm"
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Trade</span>
          <input
            name="trade"
            defaultValue={source.lookup.tradeCode ?? ""}
            placeholder="HANDYMAN"
            className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm"
          />
        </label>
        <button type="submit" className="h-8 rounded-lg border border-border px-3 text-sm">
          Look up
        </button>
      </form>

      <section className={`space-y-2 rounded-xl border p-4 ${stateClass(source.decision.state)}`}>
        <h2 className="text-sm font-semibold">Lookup result</h2>
        <p className="text-sm">
          State: <strong>{REGULATORY_STATE_LABELS[source.decision.state]}</strong>
        </p>
        <p className="text-sm leading-6">{source.decision.reason}</p>
        <p className="text-xs">
          Certifies license: no. Declares legal compliance: no. Nationwide coverage: no. Gates estimates/jobs: no.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Researched Florida / Lee County example</h2>
        <NoteCard note={source.catalogExample} />
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            Ordinance 23-09:{" "}
            <a href={LEE_COUNTY_ORDINANCE_23_09_URL} className="underline underline-offset-2" target="_blank" rel="noreferrer">
              {LEE_COUNTY_ORDINANCE_23_09_URL}
            </a>
          </li>
          <li>
            Florida Statutes § 489.103:{" "}
            <a href={FLORIDA_STATUTE_489_103_URL} className="underline underline-offset-2" target="_blank" rel="noreferrer">
              {FLORIDA_STATUTE_489_103_URL}
            </a>
          </li>
          <li>
            Florida DBPR Construction FAQs:{" "}
            <a href={FLORIDA_DBPR_CONSTRUCTION_FAQ_URL} className="underline underline-offset-2" target="_blank" rel="noreferrer">
              {FLORIDA_DBPR_CONSTRUCTION_FAQ_URL}
            </a>
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Tenant-recorded notes</h2>
        {source.tenantNotes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tenant-recorded notes are on file. Absence is UNKNOWN, not a finding that the business is unlicensed or compliant.
          </p>
        ) : (
          source.tenantNotes.map((note) => <NoteCard key={note.id} note={note} />)
        )}
      </section>
    </div>
  );
}

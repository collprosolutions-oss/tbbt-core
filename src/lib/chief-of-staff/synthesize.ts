/**
 * Deterministic grounded fallback and one-voice synthesis payload.
 * Never names internal specialists. Never persists chain-of-thought.
 */
import { answerCoachFromFacts, COACH_FACT_KEYS, type CoachContext } from "@/lib/ai/coach";
import { filterAuthorizedCitedFactKeys } from "@/lib/ai/service";
import { sanitizeAiText } from "@/lib/ai/sanitize";
import type { CitedFact, StructuredAiOutput } from "@/lib/ai/types";
import type { CanonicalRecommendationCatalog } from "@/lib/chief-of-staff/recommendations";
import type {
  ConflictResolution,
  SkippedSpecialist,
  SpecialistResult,
} from "@/lib/chief-of-staff/types";

export type CosSynthesis = {
  output: StructuredAiOutput;
  citedFacts: CitedFact[];
  recommendationKeys: string[];
  payload: Record<string, unknown>;
};

const OWNER_FINDING_CAP = 8;

function oneVoice(text: string) {
  return text
    .replace(/\b(Finance|Workforce|Growth|Knowledge|Materials|Communications|Vault|Protection|Attention) Agent says\b/gi, "Recorded facts show")
    .replace(/\b(the )?(Finance|Workforce|Growth|Knowledge|Materials|Communications|Vault|Protection|Attention|Business Protection) specialist\b/gi, "recorded facts");
}

function boundedRecordedFindings(usable: SpecialistResult[]) {
  const seen = new Set<string>();
  const items: Array<{ key: string; title: string; summary: string }> = [];
  for (const row of usable) {
    for (const finding of row.findings) {
      const key = finding.key.trim();
      const title = finding.title.trim();
      const summary = finding.summary.trim();
      if (!key || !title || !summary) continue;
      if (seen.has(key) || seen.has(summary)) continue;
      seen.add(key);
      seen.add(summary);
      items.push({ key, title, summary });
      if (items.length >= OWNER_FINDING_CAP) return items;
    }
  }
  return items;
}

export function synthesizeCoachAnswer(input: {
  question: string;
  coachContext: CoachContext;
  catalog: CanonicalRecommendationCatalog;
  specialistResults: SpecialistResult[];
  conflicts: ConflictResolution;
  plannerSkipped?: SkippedSpecialist[];
}): CosSynthesis {
  const grounded = answerCoachFromFacts(input.question, input.coachContext);
  const usable = input.specialistResults.filter((row) => row.status === "OK");
  const failed = input.specialistResults.filter((row) => row.status === "FAILED");
  const skipped = input.specialistResults.filter((row) => row.status === "SKIPPED");
  const extraNotes: string[] = [];

  const uniqueKeys = input.conflicts.uniqueRecommendationKeys;
  const recs = input.catalog.activeRecommendations.filter((item) => uniqueKeys.includes(item.key));
  if (recs.length > 0 && /this week|focus|should i|attention today|work on next/i.test(input.question)) {
    const titles = recs.slice(0, 3).map((item) => item.title);
    extraNotes.push(`Recorded attention, in one list: ${titles.join("; ")}.`);
  }

  const conflictNotes = input.conflicts.items
    .filter((conflict) => conflict.kind !== "DUPLICATE_RECOMMENDATION")
    .map((conflict) => conflict.summary);
  if (conflictNotes.length > 0) {
    extraNotes.push(`Conflicts from recorded truth: ${conflictNotes.join(" ")}`);
  }

  const recordedFindings = boundedRecordedFindings(usable);
  extraNotes.push(...recordedFindings.map((item) => item.summary));

  for (const row of usable) {
    if (
      row.specialistId !== "KNOWLEDGE_LAUNCH" &&
      row.specialistId !== "BUSINESS_PROTECTION" &&
      row.specialistId !== "WORKFORCE"
    ) {
      continue;
    }
    if (row.limitation) extraNotes.push(row.limitation);
  }

  if (failed.length > 0) {
    extraNotes.push(
      "Part of the recorded attention view could not be loaded. The answer uses only the surviving facts and does not invent substitutes.",
    );
  }
  for (const row of skipped) {
    if (row.limitation) extraNotes.push(row.limitation);
  }
  if (
    input.plannerSkipped?.some(
      (row) => row.reason === "DISABLED" || row.reason === "NO_DEEP_LOAD_PR1",
    )
  ) {
    extraNotes.push(
      "A requested recorded view is not enabled for this workspace. Missing data was not replaced with empty or zero values.",
    );
  }

  const text = oneVoice(
    [grounded.output.text, ...extraNotes].filter(Boolean).join(" "),
  );

  const allowlist = new Set<string>(COACH_FACT_KEYS);
  const citedFacts = dedupeFacts([
    ...grounded.citedFacts,
    ...usable.flatMap((row) =>
      input.coachContext.facts
        ? grounded.citedFacts.filter((fact) => row.factKeys.includes(fact.key))
        : [],
    ),
  ]).filter((fact) => allowlist.has(fact.key));
  const allowed = citedFacts.map((fact) => fact.key);
  const citedFactKeys = filterAuthorizedCitedFactKeys(
    [...new Set([...grounded.output.citedFactKeys, ...usable.flatMap((row) => row.factKeys)])],
    allowed,
  );

  const output: StructuredAiOutput = {
    text: sanitizeAiText(text, 4_000),
    stance: grounded.output.stance,
    citedFactKeys,
    notes: grounded.output.notes,
  };

  const payload = {
    question: sanitizeAiText(input.question, 1_000),
    facts: citedFacts,
    recommendations: recs.map((item) => ({
      key: item.key,
      title: item.title,
      why: item.why,
    })),
    conflicts: input.conflicts.items.map((item) => ({
      kind: item.kind,
      recommendationKeys: item.recommendationKeys,
      summary: item.summary,
    })),
    limitations: [
      ...failed.map((row) => row.limitation ?? row.failure?.message ?? "A recorded view was unavailable."),
      ...skipped.map((row) => row.limitation ?? "A recorded view was not available."),
    ],
    recordedFindings,
  };

  return {
    output,
    citedFacts,
    recommendationKeys: uniqueKeys,
    payload,
  };
}

function dedupeFacts(facts: CitedFact[]) {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    if (seen.has(fact.key)) return false;
    seen.add(fact.key);
    return true;
  });
}

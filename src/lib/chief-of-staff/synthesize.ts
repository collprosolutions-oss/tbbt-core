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
  SpecialistResult,
} from "@/lib/chief-of-staff/types";

export type CosSynthesis = {
  output: StructuredAiOutput;
  citedFacts: CitedFact[];
  recommendationKeys: string[];
  payload: Record<string, unknown>;
};

function oneVoice(text: string) {
  return text
    .replace(/\b(Finance|Workforce|Growth|Knowledge|Materials|Communications|Vault|Protection) Agent says\b/gi, "Recorded facts show")
    .replace(/\b(the )?(Finance|Workforce|Growth|Knowledge|Materials|Communications|Vault) specialist\b/gi, "recorded facts");
}

export function synthesizeCoachAnswer(input: {
  question: string;
  coachContext: CoachContext;
  catalog: CanonicalRecommendationCatalog;
  specialistResults: SpecialistResult[];
  conflicts: ConflictResolution;
}): CosSynthesis {
  const grounded = answerCoachFromFacts(input.question, input.coachContext);
  const usable = input.specialistResults.filter((row) => row.status === "OK");
  const failed = input.specialistResults.filter((row) => row.status === "FAILED");
  const skipped = input.specialistResults.filter((row) => row.status === "SKIPPED");
  const extraNotes: string[] = [];

  const uniqueKeys = input.conflicts.uniqueRecommendationKeys;
  const recs = input.catalog.activeRecommendations.filter((item) => uniqueKeys.includes(item.key));
  if (recs.length > 0 && /this week|focus|should i/i.test(input.question)) {
    const titles = recs.slice(0, 3).map((item) => item.title);
    extraNotes.push(`Recorded attention, in one list: ${titles.join("; ")}.`);
  }

  for (const conflict of input.conflicts.items) {
    if (conflict.kind === "DUPLICATE_RECOMMENDATION") continue;
    extraNotes.push(conflict.summary);
  }

  const financialFindings = usable
    .filter((row) => row.specialistId === "FINANCIAL")
    .flatMap((row) => row.findings)
    .slice(0, 6);
  for (const finding of financialFindings) {
    extraNotes.push(finding.summary);
  }

  const growthFindings = usable
    .filter((row) => row.specialistId === "GROWTH")
    .flatMap((row) => row.findings)
    .slice(0, 6);
  for (const finding of growthFindings) {
    extraNotes.push(finding.summary);
  }

  const materialsFindings = usable
    .filter((row) => row.specialistId === "MATERIALS")
    .flatMap((row) => row.findings)
    .slice(0, 6);
  for (const finding of materialsFindings) {
    extraNotes.push(finding.summary);
  }

  const communicationsFindings = usable
    .filter((row) => row.specialistId === "COMMUNICATIONS")
    .flatMap((row) => row.findings)
    .slice(0, 6);
  for (const finding of communicationsFindings) {
    extraNotes.push(finding.summary);
  }

  const knowledgeLaunchFindings = usable
    .filter((row) => row.specialistId === "KNOWLEDGE_LAUNCH")
    .flatMap((row) => row.findings)
    .slice(0, 6);
  for (const finding of knowledgeLaunchFindings) {
    extraNotes.push(finding.summary);
  }
  for (const row of usable) {
    if (row.specialistId !== "KNOWLEDGE_LAUNCH") continue;
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

  for (const row of usable) {
    if (row.specialistId !== "WORKFORCE") continue;
    for (const finding of row.findings.slice(0, 8)) {
      extraNotes.push(finding.summary);
    }
    if (row.limitation) extraNotes.push(row.limitation);
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
    recordedFindings: [...financialFindings, ...growthFindings, ...materialsFindings, ...communicationsFindings, ...knowledgeLaunchFindings].map((item) => ({
      key: item.key,
      title: item.title,
      summary: item.summary,
    })),
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

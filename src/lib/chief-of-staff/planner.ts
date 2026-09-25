/**
 * Deterministic first-pass planner. No LLM. Recursion depth is 1:
 * specialists cannot be selected from other specialist output.
 */
import { sanitizeAiText } from "@/lib/ai/sanitize";
import { isSpecialistEnabled } from "@/lib/chief-of-staff/registry";
import { isGrowthOwnedRecommendationKey } from "@/lib/chief-of-staff/growth-specialist";
import { isFinancialOwnedRecommendationKey } from "@/lib/chief-of-staff/specialists/financial";
import {
  MAX_RECURSION_DEPTH,
  MAX_SPECIALIST_FANOUT,
  type CosPlannerInput,
  type SkippedSpecialist,
  type SpecialistId,
  type SpecialistSelection,
} from "@/lib/chief-of-staff/types";

const WORKFORCE_QUESTION =
  /\b(schedule|calendar|crew|workers?|employee|helper|staff(?:ing)?|workforce|capacity|availability|available (?:workers?|staff|capacity|days?|slots?|helpers?)|assign(?:ment|ed|ees?)?|unassigned|double[- ]?book(?:ed|ing)?|overload(?:ed)?|skills?|qualified|qualification|progression|today|tomorrow|next week|this week(?:'s)? (?:schedule|calendar|crew|staff|capacity)|fill[- ]?in|bench|who can|who should i send|skill match)\b/i;
const FINANCIAL_QUESTION =
  /\b(profit(?:ability)?|invoices?|receivables?|expenses?|margin|cash|revenue|payroll|payments?|unpaid|outstanding|collected|recurring (?:cost|expense)s?|labor (?:cost|burden)|(?:hourly )?wages?|pricing|target margin|estimate[- ]vs[- ]actual|customer concentration|losing money|making money)\b/i;
const GROWTH_QUESTION =
  /\b(leads?|lead funnel|lead source|pipeline|recover(?:y|ed)?(?: leads?)?|reactivat(?:e|ion)(?: customers?)?|campaigns?|marketing|attribution|(?:lead )?sources?|referrals?|reviews?|repeat customers?|customer retention|local (?:marketing|growth)|conversion|lost leads?|follow-up opportunities|growth)\b/i;
const KNOWLEDGE_QUESTION =
  /\b(knowledge|launch|procedures?|experience candidates?|approval)\b/i;
const MATERIALS_QUESTION = /\b(materials?|suppliers?|purchase orders?|inventory)\b/i;
const COMMUNICATIONS_QUESTION = /\b(sms|text messages?|phone calls?|communications?)\b/i;
const PROTECTION_QUESTION = /\b(vault|agreements?|esign|insurance|business protection)\b/i;
const FOCUS_QUESTION = /\b(this week|focus|should i|what should i)\b/i;
const WORKFORCE_REC_PREFIX = "workforce-";

const DISABLED_KEYWORD_HINTS: Array<{ id: SpecialistId; pattern: RegExp }> = [
  { id: "FINANCIAL", pattern: FINANCIAL_QUESTION },
  { id: "GROWTH", pattern: GROWTH_QUESTION },
  { id: "KNOWLEDGE_LAUNCH", pattern: KNOWLEDGE_QUESTION },
  { id: "MATERIALS", pattern: MATERIALS_QUESTION },
  { id: "COMMUNICATIONS", pattern: COMMUNICATIONS_QUESTION },
  { id: "BUSINESS_PROTECTION", pattern: PROTECTION_QUESTION },
];

export function sanitizePlannerQuestion(question: string) {
  return sanitizeAiText(question, 1_000);
}

export function planSpecialists(input: CosPlannerInput): SpecialistSelection {
  const question = sanitizePlannerQuestion(input.question);
  const skipped: SkippedSpecialist[] = [];
  const selected: SpecialistId[] = [];

  selected.push("ATTENTION");

  const workforceKeys = input.activeRecommendationKeys.filter((key) =>
    key.startsWith(WORKFORCE_REC_PREFIX),
  );
  const workforceHint = input.entityHints?.recommendationKey?.startsWith(WORKFORCE_REC_PREFIX);
  const otherDepartment =
    FINANCIAL_QUESTION.test(question) ||
    GROWTH_QUESTION.test(question) ||
    KNOWLEDGE_QUESTION.test(question) ||
    MATERIALS_QUESTION.test(question) ||
    COMMUNICATIONS_QUESTION.test(question) ||
    PROTECTION_QUESTION.test(question);
  const wantsWorkforce =
    WORKFORCE_QUESTION.test(question) ||
    Boolean(workforceHint) ||
    (workforceKeys.length > 0 && !otherDepartment);

  if (wantsWorkforce && isSpecialistEnabled("WORKFORCE")) {
    selected.push("WORKFORCE");
  } else if (WORKFORCE_QUESTION.test(question) && !isSpecialistEnabled("WORKFORCE")) {
    skipped.push({ id: "WORKFORCE", reason: "DISABLED" });
  }

  const financialKeys = input.activeRecommendationKeys.filter((key) =>
    isFinancialOwnedRecommendationKey(key),
  );
  const financialHint =
    input.entityHints?.recommendationKey != null &&
    isFinancialOwnedRecommendationKey(input.entityHints.recommendationKey);
  const wantsFinancial =
    FINANCIAL_QUESTION.test(question) || financialKeys.length > 0 || Boolean(financialHint);

  if (wantsFinancial && isSpecialistEnabled("FINANCIAL")) {
    selected.push("FINANCIAL");
  } else if (FINANCIAL_QUESTION.test(question) && !isSpecialistEnabled("FINANCIAL")) {
    skipped.push({ id: "FINANCIAL", reason: "DISABLED" });
  }

  const growthKeys = input.activeRecommendationKeys.filter((key) =>
    isGrowthOwnedRecommendationKey(key),
  );
  const growthHint =
    input.entityHints?.recommendationKey != null &&
    isGrowthOwnedRecommendationKey(input.entityHints.recommendationKey);
  const wantsGrowth =
    GROWTH_QUESTION.test(question) || growthKeys.length > 0 || Boolean(growthHint);

  if (wantsGrowth && isSpecialistEnabled("GROWTH")) {
    selected.push("GROWTH");
  } else if (GROWTH_QUESTION.test(question) && !isSpecialistEnabled("GROWTH")) {
    skipped.push({ id: "GROWTH", reason: "DISABLED" });
  }

  const isFocus = FOCUS_QUESTION.test(question);
  for (const hint of DISABLED_KEYWORD_HINTS) {
    if (!hint.pattern.test(question)) continue;
    if (isSpecialistEnabled(hint.id)) continue;
    skipped.push({
      id: hint.id,
      reason: isFocus ? "NO_DEEP_LOAD_PR1" : "DISABLED",
    });
  }

  if (isFocus) {
    const allowed = new Set<SpecialistId>(["ATTENTION"]);
    if (wantsWorkforce) {
      allowed.add("WORKFORCE");
    }
    if ((financialKeys.length > 0 || Boolean(financialHint)) && isSpecialistEnabled("FINANCIAL")) {
      allowed.add("FINANCIAL");
    }
    if ((growthKeys.length > 0 || Boolean(growthHint)) && isSpecialistEnabled("GROWTH")) {
      allowed.add("GROWTH");
    }
    for (const id of [...selected]) {
      if (!allowed.has(id)) {
        skipped.push({ id, reason: "UNKNOWN_QUESTION" });
      }
    }
    const focused = selected.filter((id) => allowed.has(id));
    return finalize(focused, skipped);
  }

  const recognized =
    wantsWorkforce ||
    FINANCIAL_QUESTION.test(question) ||
    GROWTH_QUESTION.test(question) ||
    KNOWLEDGE_QUESTION.test(question) ||
    MATERIALS_QUESTION.test(question) ||
    COMMUNICATIONS_QUESTION.test(question) ||
    PROTECTION_QUESTION.test(question) ||
    FOCUS_QUESTION.test(question) ||
    /\b(unpaid|review|market|customer|invoice|estimate|job)\b/i.test(question);

  if (!recognized && selected.length > 1) {
    return finalize(["ATTENTION"], [
      ...skipped,
      ...selected
        .filter((id) => id !== "ATTENTION")
        .map((id) => ({ id, reason: "UNKNOWN_QUESTION" as const })),
    ]);
  }

  if (!recognized) {
    skipped.push(
      ...(["FINANCIAL", "GROWTH", "KNOWLEDGE_LAUNCH", "MATERIALS", "COMMUNICATIONS", "BUSINESS_PROTECTION"] as const)
        .filter((id) => !skipped.some((row) => row.id === id))
        .map((id) => ({ id, reason: "UNKNOWN_QUESTION" as const })),
    );
  }

  return finalize(selected, skipped);
}

function finalize(selected: SpecialistId[], skipped: SkippedSpecialist[]): SpecialistSelection {
  const unique: SpecialistId[] = [];
  for (const id of selected) {
    if (unique.includes(id)) continue;
    if (!isSpecialistEnabled(id)) {
      skipped.push({ id, reason: "DISABLED" });
      continue;
    }
    unique.push(id);
  }
  const capped = unique.slice(0, MAX_SPECIALIST_FANOUT);
  for (const id of unique.slice(MAX_SPECIALIST_FANOUT)) {
    skipped.push({ id, reason: "FANOUT_CAP" });
  }
  return {
    selectedIds: capped,
    skipped: dedupeSkipped(skipped),
    recursionDepth: MAX_RECURSION_DEPTH,
    fanout: capped.length,
  };
}

function dedupeSkipped(skipped: SkippedSpecialist[]) {
  const seen = new Set<string>();
  return skipped.filter((row) => {
    const key = `${row.id}:${row.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

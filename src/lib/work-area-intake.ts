/**
 * Customer work-area intake for variable-scope / custom-work services.
 *
 * Preview cannot add Prisma columns, so answers are encoded in
 * ServiceRequest.description after a stable marker. Owner calculator
 * changes never rewrite this record. Customer pages never see rates.
 */
import {
  DECORATIVE_WALL_PANELING_CALCULATOR_ID,
  DECORATIVE_WALL_PANELING_TITLE,
} from "@/lib/estimate-calculators/decorative-wall-paneling";
import {
  CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
  type CalculatorDefinition,
} from "@/lib/estimate-calculators/types";
import { normalizeVariableScopeComponents } from "@/lib/estimate-calculators/variable-scope";
import {
  isBelongingsCleanupLevel,
  isContentsProtectionLevel,
  isWorkAreaHandlingLevel,
} from "@/lib/estimate-calculators/work-area-services";
import { catalogCalculatorDefinition } from "@/lib/estimate-line-scope";

export const WORK_AREA_INTAKE_MARKER = "\n\nTBBT Work Area Intake:\n";
export const INTAKE_SUBMISSION_MARKER = "\n\nTBBT Intake Submission:\n";

export const WORK_AREA_INTAKE_CLARIFICATION =
  "Final handling, protection, and cleanup requirements may be adjusted after site review if actual work-area conditions differ from the selections provided.";

export const WORK_AREA_INTAKE_HANDLING_OPTIONS = [
  { value: "clear", label: "Work area clear / ready" },
  { value: "light", label: "Light contents moving needed" },
  { value: "moderate", label: "Moderate contents moving needed" },
  { value: "heavy", label: "Heavy contents moving needed" },
] as const;

export const WORK_AREA_INTAKE_PROTECTION_OPTIONS = [
  { value: "none", label: "No contractor protection required" },
  { value: "light", label: "Light protection" },
  { value: "moderate", label: "Moderate protection" },
  { value: "heavy", label: "Heavy protection" },
] as const;

export const WORK_AREA_INTAKE_CLEANUP_OPTIONS = [
  { value: "none", label: "Not included / not required" },
  { value: "light", label: "Light belongings cleanup" },
  { value: "moderate", label: "Moderate belongings cleanup" },
  { value: "heavy", label: "Heavy belongings cleanup" },
] as const;

export const WORK_AREA_CALCULATOR_INPUT_KEYS = [
  "contentsHandlingLevel",
  "contentsProtectionLevel",
  "belongingsCleanupLevel",
] as const;

export type WorkAreaIntakeAnswer = {
  catalogItemId: string;
  contentsHandling: (typeof WORK_AREA_INTAKE_HANDLING_OPTIONS)[number]["value"];
  contentsProtection: (typeof WORK_AREA_INTAKE_PROTECTION_OPTIONS)[number]["value"];
  belongingsCleanup: (typeof WORK_AREA_INTAKE_CLEANUP_OPTIONS)[number]["value"];
};

export type WorkAreaIntakeRecord = {
  answers: WorkAreaIntakeAnswer[];
};

export function isWorkAreaIntakeHandling(
  value: unknown,
): value is WorkAreaIntakeAnswer["contentsHandling"] {
  return WORK_AREA_INTAKE_HANDLING_OPTIONS.some((option) => option.value === value);
}

export function isWorkAreaIntakeProtection(
  value: unknown,
): value is WorkAreaIntakeAnswer["contentsProtection"] {
  return WORK_AREA_INTAKE_PROTECTION_OPTIONS.some((option) => option.value === value);
}

export function isWorkAreaIntakeCleanup(
  value: unknown,
): value is WorkAreaIntakeAnswer["belongingsCleanup"] {
  return WORK_AREA_INTAKE_CLEANUP_OPTIONS.some((option) => option.value === value);
}

export function calculatorAsksWorkAreaIntake(
  definition?: Pick<CalculatorDefinition, "calculatorId" | "components" | "intake"> | null,
) {
  if (!definition) return false;
  if (definition.intake?.workArea === false) return false;
  if (definition.intake?.workArea === true) return true;
  if (definition.calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID) {
    return true;
  }
  if (definition.calculatorId !== CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID) {
    return false;
  }
  const keys = new Set(
    normalizeVariableScopeComponents(definition.components).map(
      (component) => component.quantityKey ?? component.key,
    ),
  );
  return WORK_AREA_CALCULATOR_INPUT_KEYS.every((key) => keys.has(key));
}

export function catalogAsksWorkAreaIntake(
  description?: string | null,
  title?: string | null,
) {
  try {
    const definition = catalogCalculatorDefinition(description);
    if (definition) return calculatorAsksWorkAreaIntake(definition);
    const name = title?.trim().toLowerCase();
    return name === DECORATIVE_WALL_PANELING_TITLE.toLowerCase();
  } catch {
    return false;
  }
}

export function workAreaIntakeOptionLabel(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: string,
) {
  return labelFor(options, value);
}

export function normalizeWorkAreaIntakeAnswer(
  raw: unknown,
): WorkAreaIntakeAnswer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const catalogItemId =
    typeof item.catalogItemId === "string" ? item.catalogItemId.trim() : "";
  if (
    !catalogItemId ||
    !isWorkAreaIntakeHandling(item.contentsHandling) ||
    !isWorkAreaIntakeProtection(item.contentsProtection) ||
    !isWorkAreaIntakeCleanup(item.belongingsCleanup)
  ) {
    return null;
  }
  return {
    catalogItemId,
    contentsHandling: item.contentsHandling,
    contentsProtection: item.contentsProtection,
    belongingsCleanup: item.belongingsCleanup,
  };
}

export function normalizeWorkAreaIntakeRecord(raw: unknown): WorkAreaIntakeRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const answers = Array.isArray((raw as { answers?: unknown }).answers)
    ? (raw as { answers: unknown[] }).answers
        .map(normalizeWorkAreaIntakeAnswer)
        .filter((item): item is WorkAreaIntakeAnswer => item != null)
    : [];
  return answers.length > 0 ? { answers } : null;
}

export function parseWorkAreaIntake(
  description?: string | null,
): WorkAreaIntakeRecord | null {
  const block = encodedBlockAfter(description, WORK_AREA_INTAKE_MARKER);
  if (!block) return null;
  try {
    return normalizeWorkAreaIntakeRecord(JSON.parse(block));
  } catch {
    return null;
  }
}

export function parseIntakeSubmissionId(description?: string | null) {
  const token = encodedBlockAfter(description, INTAKE_SUBMISSION_MARKER);
  return normalizeIntakeSubmissionId(token);
}

export function requestNotesText(description?: string | null) {
  const raw = description ?? "";
  let cut = raw.length;
  for (const marker of [WORK_AREA_INTAKE_MARKER, INTAKE_SUBMISSION_MARKER]) {
    const index = raw.indexOf(marker);
    if (index !== -1 && index < cut) cut = index;
  }
  return raw.slice(0, cut).trim() || null;
}

export function joinRequestDescription(
  notes?: string | null,
  intake?: WorkAreaIntakeRecord | null,
  submissionId?: string | null,
) {
  const cleanNotes = requestNotesText(notes) ?? "";
  const record = normalizeWorkAreaIntakeRecord(intake);
  const token = normalizeIntakeSubmissionId(submissionId);
  let result = cleanNotes;
  if (token) result += `${INTAKE_SUBMISSION_MARKER}${token}`;
  if (record) result += `${WORK_AREA_INTAKE_MARKER}${JSON.stringify(record)}`;
  return result || null;
}

export function normalizeIntakeSubmissionId(value?: string | null) {
  const token = (value ?? "").trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(token) ? token : null;
}

export function validateWorkAreaIntakeAnswer(input: {
  catalogItemId: string;
  contentsHandling?: string;
  contentsProtection?: string;
  belongingsCleanup?: string;
}): { ok: true; answer: WorkAreaIntakeAnswer } | { ok: false; error: string } {
  const answer = normalizeWorkAreaIntakeAnswer(input);
  if (!answer) {
    return {
      ok: false,
      error: "Please answer the work-area questions for the selected work.",
    };
  }
  return { ok: true, answer };
}

export function workAreaIntakeToCalculatorInputs(answer: WorkAreaIntakeAnswer) {
  return {
    contentsHandlingLevel: answer.contentsHandling,
    contentsProtectionLevel: answer.contentsProtection,
    belongingsCleanupLevel: answer.belongingsCleanup,
  };
}

export function pickWorkAreaCalculatorInputs(
  inputs?: Record<string, unknown> | null,
) {
  const next: Record<string, string> = {};
  if (isWorkAreaHandlingLevel(inputs?.contentsHandlingLevel)) {
    next.contentsHandlingLevel = inputs.contentsHandlingLevel;
  }
  if (isContentsProtectionLevel(inputs?.contentsProtectionLevel)) {
    next.contentsProtectionLevel = inputs.contentsProtectionLevel;
  }
  if (isBelongingsCleanupLevel(inputs?.belongingsCleanupLevel)) {
    next.belongingsCleanupLevel = inputs.belongingsCleanupLevel;
  }
  return next;
}

export function workAreaAnswerForCatalog(
  record: WorkAreaIntakeRecord | null | undefined,
  catalogItemId?: string | null,
) {
  if (!record || !catalogItemId) return null;
  return record.answers.find((answer) => answer.catalogItemId === catalogItemId) ?? null;
}

export function formatWorkAreaIntakeLabels(
  record: WorkAreaIntakeRecord | null | undefined,
  names?: Record<string, string>,
) {
  if (!record) return [];
  return record.answers.map((answer) => {
    const name = names?.[answer.catalogItemId]?.trim() || "Selected work";
    return `${name}: ${labelFor(WORK_AREA_INTAKE_HANDLING_OPTIONS, answer.contentsHandling)}; ${labelFor(WORK_AREA_INTAKE_PROTECTION_OPTIONS, answer.contentsProtection)}; ${labelFor(WORK_AREA_INTAKE_CLEANUP_OPTIONS, answer.belongingsCleanup)}`;
  });
}

export function parseWorkAreaFormAnswers(rawValues: string[]) {
  return rawValues.flatMap((raw) => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const answer = normalizeWorkAreaIntakeAnswer(parsed);
      return answer ? [answer] : [];
    } catch {
      return [];
    }
  });
}

function encodedBlockAfter(description: string | null | undefined, marker: string) {
  const raw = description ?? "";
  const index = raw.indexOf(marker);
  if (index === -1) return "";
  let rest = raw.slice(index + marker.length).trim();
  const nextMarker = rest.search(/\n\nTBBT /);
  if (nextMarker !== -1) rest = rest.slice(0, nextMarker).trim();
  return rest;
}

function labelFor(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: string,
) {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * Customer work-area intake for variable-scope / custom-work services.
 *
 * Preview cannot add Prisma columns, so answers are encoded in
 * ServiceRequest.description after a stable marker. Owner calculator
 * changes never rewrite this record. Customer pages never see rates.
 */
import { DECORATIVE_WALL_PANELING_TEMPLATE } from "@/lib/estimate-calculators/decorative-wall-paneling-template";
import {
  CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
  isCalculatorId,
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
  const components =
    definition.calculatorId === CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID
      ? normalizeVariableScopeComponents(definition.components)
      : isCalculatorId(definition.calculatorId) &&
          definition.calculatorId === DECORATIVE_WALL_PANELING_TEMPLATE.calculatorId
        ? DECORATIVE_WALL_PANELING_TEMPLATE.components
        : normalizeVariableScopeComponents(definition.components);
  const keys = new Set(
    components.map((component) => component.quantityKey ?? component.key),
  );
  return WORK_AREA_CALCULATOR_INPUT_KEYS.every((key) => keys.has(key));
}

export function catalogAsksWorkAreaIntake(
  description?: string | null,
  title?: string | null,
) {
  const definition = catalogCalculatorDefinition(description);
  if (definition) return calculatorAsksWorkAreaIntake(definition);
  const name = title?.trim().toLowerCase();
  if (
    name &&
    name === DECORATIVE_WALL_PANELING_TEMPLATE.title.toLowerCase() &&
    isCalculatorId(DECORATIVE_WALL_PANELING_TEMPLATE.calculatorId)
  ) {
    return calculatorAsksWorkAreaIntake({
      calculatorId: DECORATIVE_WALL_PANELING_TEMPLATE.calculatorId,
      components: DECORATIVE_WALL_PANELING_TEMPLATE.components,
      intake: DECORATIVE_WALL_PANELING_TEMPLATE.intake,
    });
  }
  return false;
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
  const raw = description ?? "";
  const index = raw.indexOf(WORK_AREA_INTAKE_MARKER);
  if (index === -1) return null;
  try {
    return normalizeWorkAreaIntakeRecord(
      JSON.parse(raw.slice(index + WORK_AREA_INTAKE_MARKER.length).trim()),
    );
  } catch {
    return null;
  }
}

export function requestNotesText(description?: string | null) {
  const raw = description ?? "";
  const index = raw.indexOf(WORK_AREA_INTAKE_MARKER);
  return (index === -1 ? raw : raw.slice(0, index)).trim() || null;
}

export function joinRequestDescription(
  notes?: string | null,
  intake?: WorkAreaIntakeRecord | null,
) {
  const cleanNotes = requestNotesText(notes) ?? "";
  const record = normalizeWorkAreaIntakeRecord(intake);
  if (!record) return cleanNotes || null;
  return `${cleanNotes}${WORK_AREA_INTAKE_MARKER}${JSON.stringify(record)}`;
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

function labelFor(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: string,
) {
  return options.find((option) => option.value === value)?.label ?? value;
}

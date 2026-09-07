import type { WorkAreaIntakeAnswer, WorkAreaIntakeRecord } from "@/lib/work-area-intake";
import {
  WORK_AREA_INTAKE_CLARIFICATION,
  normalizeWorkAreaIntakeRecord,
} from "@/lib/work-area-intake";
import type { CalculatorCustomerPolicy } from "@/lib/estimate-calculators/types";
import {
  PROJECT_CONDITIONS_POLICY_ID,
  PROJECT_CONDITIONS_TITLE,
} from "@/lib/estimate-terms/types";

const HANDLING_STATEMENTS: Record<WorkAreaIntakeAnswer["contentsHandling"], string> = {
  clear:
    "Work area will be reasonably clear and accessible before work begins.",
  light:
    "Light moving of belongings is expected so the contractor can reach the work area.",
  moderate:
    "Moderate moving of belongings is expected so the contractor can reach the work area.",
  heavy:
    "Heavy moving of belongings is expected so the contractor can reach the work area.",
};

const PROTECTION_STATEMENTS: Record<
  WorkAreaIntakeAnswer["contentsProtection"],
  string
> = {
  none: "Contractor-provided covering/protection of belongings is not included.",
  light: "Contractor will provide light protection for remaining belongings.",
  moderate:
    "Contractor will provide moderate protection for remaining belongings.",
  heavy: "Contractor will provide heavy protection for remaining belongings.",
};

const CLEANUP_STATEMENTS: Record<WorkAreaIntakeAnswer["belongingsCleanup"], string> =
  {
    none: "Additional belongings cleanup is not included.",
    light: "Light belongings cleanup is included as selected.",
    moderate: "Moderate belongings cleanup is included as selected.",
    heavy: "Heavy belongings cleanup is included as selected.",
  };

export function projectConditionStatements(
  intake?: unknown,
): string[] {
  const record = normalizeWorkAreaIntakeRecord(intake) as WorkAreaIntakeRecord | null;
  if (!record?.answers.length) return [];
  const statements: string[] = [];
  const seen = new Set<string>();
  const add = (statement: string) => {
    if (seen.has(statement)) return;
    seen.add(statement);
    statements.push(statement);
  };
  for (const answer of record.answers) {
    add(HANDLING_STATEMENTS[answer.contentsHandling]);
    add(PROTECTION_STATEMENTS[answer.contentsProtection]);
    add(CLEANUP_STATEMENTS[answer.belongingsCleanup]);
  }
  add(WORK_AREA_INTAKE_CLARIFICATION);
  return statements;
}

export function projectConditionsPolicy(
  intake?: unknown,
): CalculatorCustomerPolicy | null {
  const statements = projectConditionStatements(intake);
  if (statements.length === 0) return null;
  return {
    id: PROJECT_CONDITIONS_POLICY_ID,
    title: PROJECT_CONDITIONS_TITLE,
    family: "project",
    body: statements.map((statement) => `• ${statement}`).join("\n"),
  };
}

import type { CalculatorCustomerPolicy } from "@/lib/estimate-calculators/types";
import { splitLineDescription } from "@/lib/estimate-line-scope";
import {
  normalizeCustomerPolicies,
  uniqueCustomerPolicies,
  visibleCustomerPolicies,
  WORK_AREA_PERSONAL_PROPERTY_POLICY_ID,
} from "@/lib/estimate-policies";
import { projectConditionsPolicy } from "@/lib/estimate-terms/project-conditions";
import {
  CORE_AND_TRADE_TERM_TEMPLATES,
  termAppliesToPack,
} from "@/lib/estimate-terms/templates";
import type {
  ComposeEstimateTermsInput,
  EstimateTermPack,
} from "@/lib/estimate-terms/types";
import { PROJECT_CONDITIONS_POLICY_ID } from "@/lib/estimate-terms/types";

const CLEANING_PATTERN =
  /\bclean(?:ing|er|ers)?\b|\bmaid\b|\bjanitor(?:ial)?\b|\bhousekeep/;

const CONSTRUCTION_TAKEOFF_TYPES = new Set([
  "concrete-slab",
  "framed-wall",
  "sheet-covering",
]);

export function resolveEstimateTermPack(input: {
  titles?: Array<string | null | undefined>;
  takeoffType?: string | null;
  calculatorId?: string | null;
}): EstimateTermPack {
  if (
    CONSTRUCTION_TAKEOFF_TYPES.has(input.takeoffType ?? "") ||
    input.calculatorId === "decorative-wall-paneling"
  ) {
    return "construction";
  }
  const blob = (input.titles ?? []).filter(Boolean).join(" ").toLowerCase();
  if (CLEANING_PATTERN.test(blob)) return "cleaning";
  return "construction";
}

export function composeEstimateTerms(
  input: ComposeEstimateTermsInput,
): CalculatorCustomerPolicy[] {
  const existing = normalizeCustomerPolicies(input.existing);
  const existingById = new Map(existing.map((policy) => [policy.id, policy]));
  const pack = resolveEstimateTermPack(input);
  const applicable = CORE_AND_TRADE_TERM_TEMPLATES.filter((template) => {
    if (!termAppliesToPack(template, pack)) return false;
    if (template.when?.hasMaterials && !input.hasMaterials) return false;
    if (template.when?.hasDeposit && !input.hasDeposit) return false;
    if (
      template.id === "core-belongings-protection" &&
      existingById.has("work-area-personal-property")
    ) {
      return false;
    }
    return true;
  });

  const next: CalculatorCustomerPolicy[] = [];
  const seen = new Set<string>();
  const templateById = new Map(
    CORE_AND_TRADE_TERM_TEMPLATES.map((template) => [template.id, template]),
  );

  for (const policy of existing) {
    if (policy.id === PROJECT_CONDITIONS_POLICY_ID) continue;
    const template = templateById.get(policy.id);
    next.push(
      template && !template.optional && policy.disabled
        ? { ...policy, disabled: false }
        : policy,
    );
    seen.add(policy.id);
  }

  for (const template of applicable) {
    if (seen.has(template.id)) continue;
    const { packs: _packs, when: _when, ...policy } = template;
    next.push({
      id: policy.id,
      title: policy.title,
      body: policy.body,
      family: policy.family,
      ...(policy.optional ? { optional: true } : {}),
      ...(policy.disabled ? { disabled: true } : {}),
    });
    seen.add(template.id);
  }

  const project = projectConditionsPolicy(input.intake);
  const existingProject = existingById.get(PROJECT_CONDITIONS_POLICY_ID);
  if (existingProject) {
    next.unshift(existingProject);
  } else if (project) {
    next.unshift(project);
  }

  return next;
}

export function collectEstimateTermContext(
  lines: Array<{ type: string; description?: string | null }>,
) {
  const parts = lines.map((line) => splitLineDescription(line.description));
  return {
    existing: uniqueCustomerPolicies(parts.map((part) => part.customerPolicies)),
    titles: parts.map((part) => part.title),
    takeoffType:
      parts.map((part) => part.materialTakeoff?.takeoffType).find(Boolean) ??
      null,
    calculatorId:
      parts
        .map((part) => part.calculatorSnapshot?.calculatorId)
        .find(Boolean) ?? null,
    hasMaterials: lines.some((line) => line.type === "MATERIAL"),
  };
}

export function resolveEstimateDocumentTerms(
  input: ComposeEstimateTermsInput & { freezeSnapshot?: boolean },
) {
  const source = input.freezeSnapshot
    ? normalizeCustomerPolicies(input.existing)
    : composeEstimateTerms(input);
  return {
    all: source,
    visible: visibleCustomerPolicies(source),
    ...partitionEstimateTerms(source),
  };
}

export function partitionEstimateTerms(policies: CalculatorCustomerPolicy[]) {
  const visible = visibleCustomerPolicies(policies);
  const projectConditions =
    visible.find((policy) => policy.family === "project") ??
    visible.find((policy) => policy.id === PROJECT_CONDITIONS_POLICY_ID) ??
    null;
  const terms = visible.filter((policy) => {
    if (policy.family === "project" || policy.id === PROJECT_CONDITIONS_POLICY_ID) {
      return false;
    }
    if (
      projectConditions &&
      policy.id === WORK_AREA_PERSONAL_PROPERTY_POLICY_ID
    ) {
      return false;
    }
    return true;
  });
  return { projectConditions, terms };
}

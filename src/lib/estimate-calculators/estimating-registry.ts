/**
 * Permanent TBBT estimating calculator registry.
 *
 * Calculator DEFINITIONS live here in application/trade code. They are
 * not catalog rows, LineItems, requests, or projects. Deleting a public
 * service, resetting a draft, or reconstructing a work line must never
 * remove these capabilities.
 *
 * Project-specific state (dimensions, quantities, rounded totals,
 * takeoff encodings) stays on estimate lines. Reusable business pricing
 * defaults live on BusinessEstimatingDefault. This file only answers:
 * which labor + material calculators apply to this work?
 *
 * Do not add Prisma columns for the registry. Preview shares Production.
 */
import type { CalculatorId } from "@/lib/estimate-calculators/types";
import {
  CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
  isCalculatorId,
} from "@/lib/estimate-calculators/types";
import { DECORATIVE_WALL_PANELING_CALCULATOR_ID } from "@/lib/estimate-calculators/decorative-wall-paneling";
import type { TakeoffTypeId } from "@/lib/material-takeoff/types";

export const ESTIMATING_WORKSPACE_IDS = [
  "concrete-slab",
  "decorative-wall-paneling",
  "framed-wall",
  "generic-custom",
] as const;

export type EstimatingWorkspaceId = (typeof ESTIMATING_WORKSPACE_IDS)[number];

export type EstimatingLaborCalculatorKind =
  | "concrete-slab-labor"
  | "variable-scope"
  | "generic-labor"
  | "none";

export type EstimatingMaterialCalculatorKind = "takeoff" | "generic-materials";

export type EstimatingWorkspaceDefinition = {
  id: EstimatingWorkspaceId;
  title: string;
  trade: string;
  /** Permanent. Catalog/project deletion cannot turn this off. */
  permanent: true;
  aliases: string[];
  labor: {
    kind: EstimatingLaborCalculatorKind;
    calculatorId?: CalculatorId;
  };
  material: {
    kind: EstimatingMaterialCalculatorKind;
    takeoffType: TakeoffTypeId;
  };
};

export const CONCRETE_SLAB_WORKSPACE_ID = "concrete-slab" as const;
export const GENERIC_CUSTOM_WORKSPACE_ID = "generic-custom" as const;

export const ESTIMATING_WORKSPACES: readonly EstimatingWorkspaceDefinition[] = [
  {
    id: CONCRETE_SLAB_WORKSPACE_ID,
    title: "Concrete slab",
    trade: "concrete",
    permanent: true,
    aliases: [
      "concrete",
      "slab",
      "shed pad",
      "patio pad",
      "footing",
      "sidewalk",
    ],
    labor: { kind: "concrete-slab-labor" },
    material: { kind: "takeoff", takeoffType: "concrete-slab" },
  },
  {
    id: "decorative-wall-paneling",
    title: "Decorative wall paneling",
    trade: "finish-carpentry",
    permanent: true,
    aliases: [
      "decorative wall paneling",
      "wall paneling",
      "plywood",
      "panel",
      "sheet",
    ],
    labor: {
      kind: "variable-scope",
      calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
    },
    material: { kind: "takeoff", takeoffType: "sheet-covering" },
  },
  {
    id: "framed-wall",
    title: "Simple framed wall",
    trade: "framing",
    permanent: true,
    aliases: ["framed wall", "stud wall", "framing", "fram"],
    labor: { kind: "none" },
    material: { kind: "takeoff", takeoffType: "framed-wall" },
  },
  {
    id: GENERIC_CUSTOM_WORKSPACE_ID,
    title: "Custom estimating workspace",
    trade: "custom",
    permanent: true,
    aliases: [],
    labor: { kind: "generic-labor" },
    material: { kind: "generic-materials", takeoffType: "generic-custom" },
  },
];

const TAKEOFF_TYPE_TO_WORKSPACE: Partial<
  Record<TakeoffTypeId, EstimatingWorkspaceId>
> = {
  "concrete-slab": CONCRETE_SLAB_WORKSPACE_ID,
  "sheet-covering": "decorative-wall-paneling",
  "framed-wall": "framed-wall",
  "generic-custom": GENERIC_CUSTOM_WORKSPACE_ID,
};

export function isEstimatingWorkspaceId(
  value: unknown,
): value is EstimatingWorkspaceId {
  return (
    typeof value === "string" &&
    (ESTIMATING_WORKSPACE_IDS as readonly string[]).includes(value)
  );
}

export function estimatingWorkspaceById(
  id: EstimatingWorkspaceId,
): EstimatingWorkspaceDefinition {
  const found = ESTIMATING_WORKSPACES.find((row) => row.id === id);
  if (!found) {
    return ESTIMATING_WORKSPACES.find((row) => row.id === GENERIC_CUSTOM_WORKSPACE_ID)!;
  }
  return found;
}

export type EstimatingWorkspaceContext = {
  title?: string | null;
  titles?: Array<string | null | undefined>;
  calculatorId?: string | null;
  takeoffType?: string | null;
  customQuote?: boolean;
  /** Linked customer request / variable-scope work should always get a workspace. */
  alwaysProvideWorkspace?: boolean;
};

/**
 * Select the registered estimating workspace for this work.
 *
 * Catalog rows may point at a calculator for default rates, but they are
 * not the registry. Matching uses request/line titles and registered
 * aliases so a deleted public service cannot hide Concrete Slab.
 */
export function resolveEstimatingWorkspace(
  input: EstimatingWorkspaceContext,
): EstimatingWorkspaceDefinition | null {
  if (input.takeoffType && TAKEOFF_TYPE_TO_WORKSPACE[input.takeoffType as TakeoffTypeId]) {
    return estimatingWorkspaceById(
      TAKEOFF_TYPE_TO_WORKSPACE[input.takeoffType as TakeoffTypeId]!,
    );
  }

  if (input.calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID) {
    return estimatingWorkspaceById("decorative-wall-paneling");
  }
  if (input.calculatorId === CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID) {
    const fromTitle = matchSpecializedWorkspace(collectTitles(input));
    return fromTitle ?? estimatingWorkspaceById(GENERIC_CUSTOM_WORKSPACE_ID);
  }
  if (isCalculatorId(input.calculatorId)) {
    const fromTitle = matchSpecializedWorkspace(collectTitles(input));
    if (fromTitle) return fromTitle;
  }

  const specialized = matchSpecializedWorkspace(collectTitles(input));
  if (specialized) return specialized;

  if (input.customQuote || input.alwaysProvideWorkspace) {
    return estimatingWorkspaceById(GENERIC_CUSTOM_WORKSPACE_ID);
  }
  return null;
}

/**
 * Custom-quote / variable-scope drafts always receive a workspace.
 * Specialized trades win; otherwise the generic safety net applies.
 */
export function resolveDraftEstimatingWorkspace(
  input: EstimatingWorkspaceContext,
): EstimatingWorkspaceDefinition {
  return (
    resolveEstimatingWorkspace({
      ...input,
      alwaysProvideWorkspace: true,
    }) ?? estimatingWorkspaceById(GENERIC_CUSTOM_WORKSPACE_ID)
  );
}

export function workspaceMaterialTakeoffType(
  workspace: EstimatingWorkspaceDefinition,
): TakeoffTypeId {
  return workspace.material.takeoffType;
}

const CUSTOM_QUOTE_TITLE_MARKER = "(custom quote — enter price)";

export function descriptionLooksLikeCustomQuote(description?: string | null) {
  return Boolean(description?.includes(CUSTOM_QUOTE_TITLE_MARKER));
}

function collectTitles(input: EstimatingWorkspaceContext) {
  return [input.title, ...(input.titles ?? [])]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
}

function matchSpecializedWorkspace(titles: string[]) {
  if (titles.length === 0) return null;
  const haystacks = titles.map((title) => title.toLowerCase());
  for (const workspace of ESTIMATING_WORKSPACES) {
    if (workspace.id === GENERIC_CUSTOM_WORKSPACE_ID) continue;
    if (
      workspace.aliases.some((alias) =>
        haystacks.some(
          (hay) => hay === alias || hay.includes(alias),
        ),
      )
    ) {
      return workspace;
    }
  }
  return null;
}

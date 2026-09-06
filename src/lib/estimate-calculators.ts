export {
  DECORATIVE_WALL_PANELING_CALCULATOR_ID,
  DECORATIVE_WALL_PANELING_TITLE,
  DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
  PANEL_EQUIVALENT_SQ_FT,
  REMOVAL_TYPES,
  computeDecorativeWallPaneling,
  emptyDecorativeWallPanelingInputs,
  grossWallAreaSqFt,
  isRemovalType,
  normalizeDecorativeWallPanelingInputs,
  normalizeDecorativeWallPanelingRates,
  suggestedPanelEquivalents,
} from "@/lib/estimate-calculators/decorative-wall-paneling";
export type {
  DecorativeWallPanelingInputs,
  DecorativeWallPanelingRates,
  RemovalType,
} from "@/lib/estimate-calculators/decorative-wall-paneling";
export {
  JOB_SPECIFIC_CALCULATOR_INPUT_KEYS,
  calculatorRatesEqual,
  calculatorSnapshotIsApplied,
  calculatorTitle,
  catalogDefinitionFromSnapshot,
  computeCalculator,
  defaultCalculatorRates,
  definitionOmitsJobQuantities,
  emptyCalculatorInputs,
  findCatalogCalculatorDefinition,
  normalizeCalculatorSnapshot,
  persistableCalculatorRates,
  resolveCalculatorId,
  resolveCalculatorRatesForForm,
  startingCalculatorSnapshot,
} from "@/lib/estimate-calculators/registry";
export { isCalculatorId, roundMoney } from "@/lib/estimate-calculators/types";
export type {
  CalculatorBreakdownLine,
  CalculatorDefinition,
  CalculatorId,
  CalculatorResult,
  CalculatorSnapshot,
} from "@/lib/estimate-calculators/types";

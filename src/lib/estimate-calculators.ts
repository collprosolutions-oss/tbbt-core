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
export { clampCount, parseTypedCount, stepCount } from "@/lib/estimate-calculators/count-input";
export {
  BELONGINGS_CLEANUP_LEVELS,
  CONTENTS_PROTECTION_LEVELS,
  DEFAULT_BELONGINGS_CLEANUP_RATES,
  DEFAULT_CONTENTS_HANDLING_RATES,
  DEFAULT_CONTENTS_PROTECTION_RATES,
  WORK_AREA_HANDLING_LEVELS,
  belongingsCleanupLabel,
  computeWorkAreaService,
  contentsProtectionLabel,
  workAreaHandlingLabel,
} from "@/lib/estimate-calculators/work-area-services";
export { DECORATIVE_WALL_PANELING_TEMPLATE } from "@/lib/estimate-calculators/decorative-wall-paneling-template";
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
  formCalculatorInputs,
  normalizeCalculatorSnapshot,
  persistableCalculatorComponents,
  persistableCalculatorRates,
  resolveCalculatorId,
  resolveCalculatorRatesForForm,
  startingCalculatorSnapshot,
  templateForCalculator,
} from "@/lib/estimate-calculators/registry";
export {
  computeVariableScope,
  defaultVariableScopeRates,
  emptyVariableScopeInputs,
  jobQuantityKeysFromTemplate,
  normalizeVariableScopeComponents,
  normalizeVariableScopeTemplate,
  persistableVariableScopeRates,
} from "@/lib/estimate-calculators/variable-scope";
export type {
  VariableScopeComponent,
  VariableScopeInputType,
  VariableScopeSection,
  VariableScopeTemplate,
} from "@/lib/estimate-calculators/variable-scope";
export {
  CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
  isCalculatorId,
  roundMoney,
} from "@/lib/estimate-calculators/types";
export type {
  CalculatorAmountState,
  CalculatorBreakdownLine,
  CalculatorCustomerPolicy,
  CalculatorDefinition,
  CalculatorId,
  CalculatorResult,
  CalculatorSnapshot,
} from "@/lib/estimate-calculators/types";

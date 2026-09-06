import { clampCount } from "@/lib/estimate-calculators/count-input";
import {
  roundMoney,
  type CalculatorAmountState,
  type CalculatorBreakdownLine,
  type CalculatorResult,
} from "@/lib/estimate-calculators/types";
import {
  DEFAULT_BELONGINGS_CLEANUP_RATES,
  DEFAULT_CONTENTS_HANDLING_RATES,
  DEFAULT_CONTENTS_PROTECTION_RATES,
  belongingsCleanupLabel,
  computeWorkAreaService,
  contentsProtectionLabel,
  isBelongingsCleanupLevel,
  isContentsProtectionLevel,
  isWorkAreaHandlingLevel,
  workAreaHandlingLabel,
  type BelongingsCleanupLevel,
  type ContentsProtectionLevel,
  type WorkAreaHandlingLevel,
} from "@/lib/estimate-calculators/work-area-services";

export const DECORATIVE_WALL_PANELING_CALCULATOR_ID =
  "decorative-wall-paneling" as const;

export const DECORATIVE_WALL_PANELING_TITLE =
  "Decorative Wall Paneling & Finish Carpentry";

export const PANEL_EQUIVALENT_SQ_FT = 32;

export const REMOVAL_TYPES = [
  "none",
  "metal_siding",
  "paneling",
  "other",
] as const;

export type RemovalType = (typeof REMOVAL_TYPES)[number];

export type DecorativeWallPanelingRates = {
  panelRate: number;
  removalRatePerSqFt: number;
  slidingPatioDoorRate: number;
  standardDoorRate: number;
  windowRate: number;
  receptacleRate: number;
  switchRate: number;
  lightFixtureRate: number;
  defaultTrimAllowance: number;
  defaultCleanupAllowance: number;
  contentsHandlingLightRate: number;
  contentsHandlingModerateRate: number;
  contentsHandlingHeavyRate: number;
  contentsProtectionLightRate: number;
  contentsProtectionModerateRate: number;
  contentsProtectionHeavyRate: number;
  belongingsCleanupLightRate: number;
  belongingsCleanupModerateRate: number;
  belongingsCleanupHeavyRate: number;
};

export type DecorativeWallPanelingInputs = {
  wallWidthFt: number;
  wallHeightFt: number;
  removalType: RemovalType;
  panelQuantity: number | null;
  slidingPatioDoors: number;
  standardDoors: number;
  windows: number;
  receptacles: number;
  switches: number;
  lightFixtures: number;
  trimAllowance: number;
  cleanupAllowance: number;
  contentsHandlingLevel: WorkAreaHandlingLevel;
  contentsHandlingCustomAmount: number;
  contentsProtectionLevel: ContentsProtectionLevel;
  contentsProtectionCustomAmount: number;
  belongingsCleanupLevel: BelongingsCleanupLevel;
  belongingsCleanupCustomAmount: number;
  notes: string;
};

export const DEFAULT_DECORATIVE_WALL_PANELING_RATES: DecorativeWallPanelingRates =
  {
    panelRate: 90,
    removalRatePerSqFt: 1.25,
    slidingPatioDoorRate: 150,
    standardDoorRate: 100,
    windowRate: 100,
    receptacleRate: 50,
    switchRate: 50,
    lightFixtureRate: 75,
    defaultTrimAllowance: 180,
    defaultCleanupAllowance: 75,
    contentsHandlingLightRate: DEFAULT_CONTENTS_HANDLING_RATES.light,
    contentsHandlingModerateRate: DEFAULT_CONTENTS_HANDLING_RATES.moderate,
    contentsHandlingHeavyRate: DEFAULT_CONTENTS_HANDLING_RATES.heavy,
    contentsProtectionLightRate: DEFAULT_CONTENTS_PROTECTION_RATES.light,
    contentsProtectionModerateRate: DEFAULT_CONTENTS_PROTECTION_RATES.moderate,
    contentsProtectionHeavyRate: DEFAULT_CONTENTS_PROTECTION_RATES.heavy,
    belongingsCleanupLightRate: DEFAULT_BELONGINGS_CLEANUP_RATES.light,
    belongingsCleanupModerateRate: DEFAULT_BELONGINGS_CLEANUP_RATES.moderate,
    belongingsCleanupHeavyRate: DEFAULT_BELONGINGS_CLEANUP_RATES.heavy,
  };

export const FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE: DecorativeWallPanelingInputs =
  {
    wallWidthFt: 24,
    wallHeightFt: 12,
    removalType: "metal_siding",
    panelQuantity: null,
    slidingPatioDoors: 1,
    standardDoors: 0,
    windows: 1,
    receptacles: 1,
    switches: 0,
    lightFixtures: 1,
    trimAllowance: 180,
    cleanupAllowance: 75,
    contentsHandlingLevel: "clear",
    contentsHandlingCustomAmount: 0,
    contentsProtectionLevel: "none",
    contentsProtectionCustomAmount: 0,
    belongingsCleanupLevel: "none",
    belongingsCleanupCustomAmount: 0,
    notes: "",
  };

export function emptyDecorativeWallPanelingInputs(
  rates: DecorativeWallPanelingRates = DEFAULT_DECORATIVE_WALL_PANELING_RATES,
): DecorativeWallPanelingInputs {
  return {
    wallWidthFt: 0,
    wallHeightFt: 0,
    removalType: "none",
    panelQuantity: null,
    slidingPatioDoors: 0,
    standardDoors: 0,
    windows: 0,
    receptacles: 0,
    switches: 0,
    lightFixtures: 0,
    trimAllowance: rates.defaultTrimAllowance,
    cleanupAllowance: rates.defaultCleanupAllowance,
    contentsHandlingLevel: "clear",
    contentsHandlingCustomAmount: 0,
    contentsProtectionLevel: "none",
    contentsProtectionCustomAmount: 0,
    belongingsCleanupLevel: "none",
    belongingsCleanupCustomAmount: 0,
    notes: "",
  };
}

export function isRemovalType(value: unknown): value is RemovalType {
  return (
    typeof value === "string" &&
    (REMOVAL_TYPES as readonly string[]).includes(value)
  );
}

export function normalizeDecorativeWallPanelingRates(
  raw?: Record<string, unknown> | null,
): DecorativeWallPanelingRates {
  const defaults = DEFAULT_DECORATIVE_WALL_PANELING_RATES;
  return {
    panelRate: moneyOr(raw?.panelRate, defaults.panelRate),
    removalRatePerSqFt: moneyOr(raw?.removalRatePerSqFt, defaults.removalRatePerSqFt),
    slidingPatioDoorRate: moneyOr(raw?.slidingPatioDoorRate, defaults.slidingPatioDoorRate),
    standardDoorRate: moneyOr(raw?.standardDoorRate, defaults.standardDoorRate),
    windowRate: moneyOr(raw?.windowRate, defaults.windowRate),
    receptacleRate: moneyOr(raw?.receptacleRate, defaults.receptacleRate),
    switchRate: moneyOr(raw?.switchRate, defaults.switchRate),
    lightFixtureRate: moneyOr(raw?.lightFixtureRate, defaults.lightFixtureRate),
    defaultTrimAllowance: moneyOr(raw?.defaultTrimAllowance, defaults.defaultTrimAllowance),
    defaultCleanupAllowance: moneyOr(
      raw?.defaultCleanupAllowance,
      defaults.defaultCleanupAllowance,
    ),
    contentsHandlingLightRate: moneyOr(
      raw?.contentsHandlingLightRate,
      defaults.contentsHandlingLightRate,
    ),
    contentsHandlingModerateRate: moneyOr(
      raw?.contentsHandlingModerateRate,
      defaults.contentsHandlingModerateRate,
    ),
    contentsHandlingHeavyRate: moneyOr(
      raw?.contentsHandlingHeavyRate,
      defaults.contentsHandlingHeavyRate,
    ),
    contentsProtectionLightRate: moneyOr(
      raw?.contentsProtectionLightRate,
      defaults.contentsProtectionLightRate,
    ),
    contentsProtectionModerateRate: moneyOr(
      raw?.contentsProtectionModerateRate,
      defaults.contentsProtectionModerateRate,
    ),
    contentsProtectionHeavyRate: moneyOr(
      raw?.contentsProtectionHeavyRate,
      defaults.contentsProtectionHeavyRate,
    ),
    belongingsCleanupLightRate: moneyOr(
      raw?.belongingsCleanupLightRate,
      defaults.belongingsCleanupLightRate,
    ),
    belongingsCleanupModerateRate: moneyOr(
      raw?.belongingsCleanupModerateRate,
      defaults.belongingsCleanupModerateRate,
    ),
    belongingsCleanupHeavyRate: moneyOr(
      raw?.belongingsCleanupHeavyRate,
      defaults.belongingsCleanupHeavyRate,
    ),
  };
}

export function normalizeDecorativeWallPanelingInputs(
  raw?: Record<string, unknown> | null,
  rates: DecorativeWallPanelingRates = DEFAULT_DECORATIVE_WALL_PANELING_RATES,
): DecorativeWallPanelingInputs {
  const empty = emptyDecorativeWallPanelingInputs(rates);
  const panelRaw = raw?.panelQuantity;
  return {
    wallWidthFt: numberOr(raw?.wallWidthFt, empty.wallWidthFt),
    wallHeightFt: numberOr(raw?.wallHeightFt, empty.wallHeightFt),
    removalType: isRemovalType(raw?.removalType) ? raw.removalType : empty.removalType,
    panelQuantity:
      panelRaw == null || panelRaw === ""
        ? null
        : Math.max(0, numberOr(panelRaw, 0)),
    slidingPatioDoors: countOr(raw?.slidingPatioDoors, empty.slidingPatioDoors),
    standardDoors: countOr(raw?.standardDoors, empty.standardDoors),
    windows: countOr(raw?.windows, empty.windows),
    receptacles: countOr(raw?.receptacles, empty.receptacles),
    switches: countOr(raw?.switches, empty.switches),
    lightFixtures: countOr(raw?.lightFixtures, empty.lightFixtures),
    trimAllowance: moneyOr(raw?.trimAllowance, rates.defaultTrimAllowance),
    cleanupAllowance: moneyOr(raw?.cleanupAllowance, rates.defaultCleanupAllowance),
    contentsHandlingLevel: isWorkAreaHandlingLevel(raw?.contentsHandlingLevel)
      ? raw.contentsHandlingLevel
      : empty.contentsHandlingLevel,
    contentsHandlingCustomAmount: moneyOr(
      raw?.contentsHandlingCustomAmount,
      empty.contentsHandlingCustomAmount,
    ),
    contentsProtectionLevel: isContentsProtectionLevel(raw?.contentsProtectionLevel)
      ? raw.contentsProtectionLevel
      : empty.contentsProtectionLevel,
    contentsProtectionCustomAmount: moneyOr(
      raw?.contentsProtectionCustomAmount,
      empty.contentsProtectionCustomAmount,
    ),
    belongingsCleanupLevel: isBelongingsCleanupLevel(raw?.belongingsCleanupLevel)
      ? raw.belongingsCleanupLevel
      : empty.belongingsCleanupLevel,
    belongingsCleanupCustomAmount: moneyOr(
      raw?.belongingsCleanupCustomAmount,
      empty.belongingsCleanupCustomAmount,
    ),
    notes: typeof raw?.notes === "string" ? raw.notes.trim() : "",
  };
}

export function grossWallAreaSqFt(widthFt: number, heightFt: number) {
  if (widthFt <= 0 || heightFt <= 0) return 0;
  return roundMoney(widthFt * heightFt);
}

export function suggestedPanelEquivalents(widthFt: number, heightFt: number) {
  const area = widthFt * heightFt;
  if (area <= 0) return 0;
  return Math.ceil(area / PANEL_EQUIVALENT_SQ_FT);
}

export function computeDecorativeWallPaneling(
  rawInputs?: Record<string, unknown> | DecorativeWallPanelingInputs | null,
  rawRates?: Record<string, unknown> | DecorativeWallPanelingRates | null,
): CalculatorResult {
  const rates = normalizeDecorativeWallPanelingRates(rawRates ?? undefined);
  const inputs = normalizeDecorativeWallPanelingInputs(rawInputs ?? undefined, rates);
  const area = grossWallAreaSqFt(inputs.wallWidthFt, inputs.wallHeightFt);
  const panels =
    inputs.panelQuantity != null && inputs.panelQuantity > 0
      ? inputs.panelQuantity
      : suggestedPanelEquivalents(inputs.wallWidthFt, inputs.wallHeightFt);
  const removalQty = inputs.removalType === "none" ? 0 : area;

  const handling = computeWorkAreaService(
    inputs.contentsHandlingLevel,
    {
      light: rates.contentsHandlingLightRate,
      moderate: rates.contentsHandlingModerateRate,
      heavy: rates.contentsHandlingHeavyRate,
    },
    inputs.contentsHandlingCustomAmount,
  );
  const protection = computeWorkAreaService(
    inputs.contentsProtectionLevel,
    {
      light: rates.contentsProtectionLightRate,
      moderate: rates.contentsProtectionModerateRate,
      heavy: rates.contentsProtectionHeavyRate,
    },
    inputs.contentsProtectionCustomAmount,
  );
  const belongings = computeWorkAreaService(
    inputs.belongingsCleanupLevel,
    {
      light: rates.belongingsCleanupLightRate,
      moderate: rates.belongingsCleanupModerateRate,
      heavy: rates.belongingsCleanupHeavyRate,
    },
    inputs.belongingsCleanupCustomAmount,
  );
  const areaEntered = inputs.wallWidthFt > 0 && inputs.wallHeightFt > 0;
  const manualPanels = inputs.panelQuantity != null && inputs.panelQuantity > 0;

  const lines: CalculatorBreakdownLine[] = [
    line(
      "panels",
      `${panels} panel-equivalent${panels === 1 ? "" : "s"}`,
      panels,
      rates.panelRate,
      areaEntered || manualPanels ? "ready" : "waiting",
    ),
    line(
      "removal",
      removalLabel(inputs.removalType),
      removalQty,
      inputs.removalType === "none" ? 0 : rates.removalRatePerSqFt,
      inputs.removalType === "none"
        ? "zero_selected"
        : areaEntered
          ? "ready"
          : "waiting",
    ),
    counted("patio-doors", "Sliding/patio door openings", inputs.slidingPatioDoors, rates.slidingPatioDoorRate),
    counted("doors", "Standard door openings", inputs.standardDoors, rates.standardDoorRate),
    counted("windows", "Window openings", inputs.windows, rates.windowRate),
    counted("receptacles", "Receptacles / outlets", inputs.receptacles, rates.receptacleRate),
    counted("switches", "Switches", inputs.switches, rates.switchRate),
    counted("fixtures", "Light fixtures", inputs.lightFixtures, rates.lightFixtureRate),
    line("trim", "Finish trim / transitions allowance", 1, inputs.trimAllowance, "ready"),
    line("cleanup", "Construction cleanup / debris handling", 1, inputs.cleanupAllowance, "ready"),
    line(
      "contents-handling",
      workAreaHandlingLabel(inputs.contentsHandlingLevel),
      handling.quantity,
      handling.rate,
      handling.explicitZero ? "zero_selected" : "ready",
    ),
    line(
      "contents-protection",
      contentsProtectionLabel(inputs.contentsProtectionLevel),
      protection.quantity,
      protection.rate,
      protection.explicitZero ? "zero_selected" : "ready",
    ),
    line(
      "belongings-cleanup",
      belongingsCleanupLabel(inputs.belongingsCleanupLevel),
      belongings.quantity,
      belongings.rate,
      belongings.explicitZero ? "zero_selected" : "ready",
    ),
  ];

  return {
    recommendedAmount: roundMoney(lines.reduce((sum, item) => sum + item.amount, 0)),
    lines,
  };
}

function counted(
  key: string,
  label: string,
  quantity: number,
  rate: number,
): CalculatorBreakdownLine {
  return line(key, label, quantity, rate, quantity > 0 ? "ready" : "not_entered");
}

function line(
  key: string,
  label: string,
  quantity: number,
  rate: number,
  amountState: CalculatorAmountState = "ready",
): CalculatorBreakdownLine {
  return {
    key,
    label,
    quantity,
    rate,
    amount: roundMoney(quantity * rate),
    amountState,
  };
}

function removalLabel(type: RemovalType) {
  if (type === "metal_siding") return "Remove existing metal siding";
  if (type === "paneling") return "Remove existing paneling";
  if (type === "other") return "Remove existing material";
  return "No existing-material removal";
}

function numberOr(value: unknown, fallback: number) {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? amount : fallback;
}

function countOr(value: unknown, fallback: number) {
  if (value == null || value === "") return fallback;
  return clampCount(value, 0);
}

function moneyOr(value: unknown, fallback: number) {
  const amount = numberOr(value, fallback);
  return amount < 0 ? fallback : roundMoney(amount);
}

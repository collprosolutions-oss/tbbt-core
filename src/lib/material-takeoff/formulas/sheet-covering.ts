/**
 * 4x8 sheet covering takeoff (decorative paneling, plywood, similar).
 *
 * Sheet count is net area after optional opening deductions, plus waste,
 * rounded up. Fasteners are an editable allowance — not fake precision.
 */
import {
  TAKEOFF_TYPE_LABELS,
  type TakeoffItem,
  type TakeoffSnapshot,
} from "@/lib/material-takeoff/types";
import {
  ceilCount,
  formatFeetInches,
  parseNonNegativeNumber,
  resolveFeetInchesInput,
  roundTakeoff,
  splitFeetAndInches,
} from "@/lib/material-takeoff/units";

export const SHEET_COVERING_TAKEOFF_ID = "sheet-covering" as const;

export const DEFAULT_SHEET_WIDTH_FT = 4;
export const DEFAULT_SHEET_HEIGHT_FT = 8;
export const DEFAULT_SHEET_WASTE_PERCENT = 10;
export const TYPICAL_SLIDING_DOOR_SQ_FT = 42;
export const TYPICAL_STANDARD_DOOR_SQ_FT = 21;
export const TYPICAL_WINDOW_SQ_FT = 12;

export type SheetCoveringInputs = {
  wallWidthFt: number;
  wallHeightFt: number;
  sheetWidthFt: number;
  sheetHeightFt: number;
  wallWidthFtPart: number;
  wallWidthInPart: number;
  wallHeightFtPart: number;
  wallHeightInPart: number;
  sheetWidthFtPart: number;
  sheetWidthInPart: number;
  sheetHeightFtPart: number;
  sheetHeightInPart: number;
  slidingPatioDoors: number;
  standardDoors: number;
  windows: number;
  includeTrim: boolean;
  includeFasteners: boolean;
  includePickup: boolean;
};

export function emptySheetCoveringInputs(
  partial?: Record<string, unknown> | null,
): SheetCoveringInputs {
  const wallWidth = resolveFeetInchesInput(
    partial,
    "wallWidthFt",
    "wallWidthFtPart",
    "wallWidthInPart",
  );
  const wallHeight = resolveFeetInchesInput(
    partial,
    "wallHeightFt",
    "wallHeightFtPart",
    "wallHeightInPart",
  );
  const sheetWidth = resolveFeetInchesInput(
    partial,
    "sheetWidthFt",
    "sheetWidthFtPart",
    "sheetWidthInPart",
  );
  const sheetHeight = resolveFeetInchesInput(
    partial,
    "sheetHeightFt",
    "sheetHeightFtPart",
    "sheetHeightInPart",
  );
  const sheetWidthFt =
    sheetWidth.totalFt > 0 ? sheetWidth.totalFt : DEFAULT_SHEET_WIDTH_FT;
  const sheetHeightFt =
    sheetHeight.totalFt > 0 ? sheetHeight.totalFt : DEFAULT_SHEET_HEIGHT_FT;
  const defaultSheetWidth = splitFeetAndInches(DEFAULT_SHEET_WIDTH_FT);
  const defaultSheetHeight = splitFeetAndInches(DEFAULT_SHEET_HEIGHT_FT);
  const sheetWidthParts =
    sheetWidth.totalFt > 0
      ? sheetWidth
      : {
          totalFt: DEFAULT_SHEET_WIDTH_FT,
          feetPart: defaultSheetWidth.feet,
          inchesPart: defaultSheetWidth.inches,
        };
  const sheetHeightParts =
    sheetHeight.totalFt > 0
      ? sheetHeight
      : {
          totalFt: DEFAULT_SHEET_HEIGHT_FT,
          feetPart: defaultSheetHeight.feet,
          inchesPart: defaultSheetHeight.inches,
        };
  return {
    wallWidthFt: wallWidth.totalFt,
    wallHeightFt: wallHeight.totalFt,
    sheetWidthFt,
    sheetHeightFt,
    wallWidthFtPart: wallWidth.feetPart,
    wallWidthInPart: wallWidth.inchesPart,
    wallHeightFtPart: wallHeight.feetPart,
    wallHeightInPart: wallHeight.inchesPart,
    sheetWidthFtPart: sheetWidthParts.feetPart,
    sheetWidthInPart: sheetWidthParts.inchesPart,
    sheetHeightFtPart: sheetHeightParts.feetPart,
    sheetHeightInPart: sheetHeightParts.inchesPart,
    slidingPatioDoors: Math.max(
      0,
      Math.floor(parseNonNegativeNumber(partial?.slidingPatioDoors) ?? 0),
    ),
    standardDoors: Math.max(
      0,
      Math.floor(parseNonNegativeNumber(partial?.standardDoors) ?? 0),
    ),
    windows: Math.max(0, Math.floor(parseNonNegativeNumber(partial?.windows) ?? 0)),
    includeTrim: partial?.includeTrim === true,
    includeFasteners: partial?.includeFasteners === true,
    includePickup: partial?.includePickup !== false,
  };
}

export function sheetNetAreaSqFt(input: SheetCoveringInputs) {
  const gross = roundTakeoff(input.wallWidthFt * input.wallHeightFt, 4);
  const openings =
    input.slidingPatioDoors * TYPICAL_SLIDING_DOOR_SQ_FT +
    input.standardDoors * TYPICAL_STANDARD_DOOR_SQ_FT +
    input.windows * TYPICAL_WINDOW_SQ_FT;
  return roundTakeoff(Math.max(0, gross - openings), 4);
}

export function sheetCountRequired(
  netAreaSqFt: number,
  wastePercent: number,
  sheetWidthFt: number,
  sheetHeightFt: number,
) {
  const sheetArea = sheetWidthFt * sheetHeightFt;
  if (netAreaSqFt <= 0 || sheetArea <= 0) return 0;
  const waste = Math.max(0, wastePercent) / 100;
  return ceilCount((netAreaSqFt * (1 + waste)) / sheetArea);
}

export function computeSheetCoveringTakeoff(input: {
  inputs?: Record<string, unknown> | null;
  wastePercent?: number;
  measurementSource?: TakeoffSnapshot["measurementSource"];
  skippedMeasurements?: string[];
}): { snapshot: TakeoffSnapshot; rejected: string | null } {
  const inputs = emptySheetCoveringInputs(input.inputs);
  const wastePercent =
    parseNonNegativeNumber(input.wastePercent) ?? DEFAULT_SHEET_WASTE_PERCENT;
  if (inputs.wallWidthFt <= 0 || inputs.wallHeightFt <= 0) {
    return {
      snapshot: blankSnapshot(inputs, wastePercent, input),
      rejected: "Sheet covering takeoff needs wall width and height greater than 0.",
    };
  }
  if (inputs.sheetWidthFt <= 0 || inputs.sheetHeightFt <= 0) {
    return {
      snapshot: blankSnapshot(inputs, wastePercent, input),
      rejected: "Sheet covering takeoff needs sheet dimensions greater than 0.",
    };
  }

  const gross = roundTakeoff(inputs.wallWidthFt * inputs.wallHeightFt, 4);
  const net = sheetNetAreaSqFt(inputs);
  const sheets = sheetCountRequired(
    net,
    wastePercent,
    inputs.sheetWidthFt,
    inputs.sheetHeightFt,
  );
  const sheetArea = roundTakeoff(inputs.sheetWidthFt * inputs.sheetHeightFt, 4);
  const perimeter = roundTakeoff(2 * (inputs.wallWidthFt + inputs.wallHeightFt), 4);
  const trimLf = ceilCount(perimeter);
  const fastenerBoxes = Math.max(1, ceilCount(sheets / 8));

  const explanation =
    `${formatFeetInches(inputs.wallWidthFt)} × ${formatFeetInches(inputs.wallHeightFt)} = ${gross} sq ft` +
    (net !== gross ? ` minus typical opening deductions → ${net} sq ft` : "") +
    `. ${wastePercent}% waste, ${formatFeetInches(inputs.sheetWidthFt)} × ${formatFeetInches(inputs.sheetHeightFt)} sheets (${sheetArea} sq ft) → ${sheets} sheets (rounded up).`;

  const items: TakeoffItem[] = [
    item({
      id: "sheets",
      kind: "sheets",
      label: `${inputs.sheetWidthFt}×${inputs.sheetHeightFt} sheets`,
      unit: "sheet",
      optional: false,
      selected: true,
      calculatedQuantity: sheets,
      explanation: `${net} sq ft × ${1 + wastePercent / 100} ÷ ${sheetArea} sq ft/sheet, rounded up.`,
    }),
    item({
      id: "trim",
      kind: "trim",
      label: "Trim / linear material",
      unit: "lf",
      optional: true,
      selected: inputs.includeTrim,
      calculatedQuantity: trimLf,
      explanation: `Wall perimeter ${perimeter} lf, rounded up. Owner-selected only.`,
    }),
    item({
      id: "fasteners",
      kind: "fasteners",
      label: "Fastener allowance",
      unit: "box",
      optional: true,
      selected: inputs.includeFasteners,
      calculatedQuantity: fastenerBoxes,
      explanation:
        "Editable allowance (about 1 box per 8 sheets). Not a counted fastener list.",
    }),
    pickupItem(inputs.includePickup),
  ];

  return {
    rejected: null,
    snapshot: {
      version: 1,
      takeoffType: SHEET_COVERING_TAKEOFF_ID,
      inputs: { ...inputs },
      wastePercent,
      markupPercent: 0,
      measurementSource: input.measurementSource ?? null,
      explanation,
      skippedMeasurements: input.skippedMeasurements ?? [],
      removedItemIds: [],
      items,
    },
  };
}

function blankSnapshot(
  inputs: SheetCoveringInputs,
  wastePercent: number,
  input: {
    measurementSource?: TakeoffSnapshot["measurementSource"];
    skippedMeasurements?: string[];
  },
): TakeoffSnapshot {
  return {
    version: 1,
    takeoffType: SHEET_COVERING_TAKEOFF_ID,
    inputs: { ...inputs },
    wastePercent,
    markupPercent: 0,
    measurementSource: input.measurementSource ?? null,
    explanation: `${TAKEOFF_TYPE_LABELS[SHEET_COVERING_TAKEOFF_ID]} needs wall width and height before quantities can be calculated.`,
    skippedMeasurements: input.skippedMeasurements ?? [],
    removedItemIds: [],
    items: [],
  };
}

function item(
  value: Omit<
    TakeoffItem,
    "quantityOverride" | "unitCost" | "customerUnitPrice" | "convertedLineItemId"
  >,
): TakeoffItem {
  return {
    ...value,
    quantityOverride: null,
    unitCost: null,
    customerUnitPrice: null,
    convertedLineItemId: null,
  };
}

function pickupItem(selected: boolean): TakeoffItem {
  return item({
    id: "pickup-procurement",
    kind: "pickup-procurement",
    label: "Material pickup / procurement",
    unit: "trip",
    optional: true,
    selected,
    calculatedQuantity: 1,
    explanation:
      "Materials do not appear on site for free. Enter a trip or allowance cost.",
  });
}

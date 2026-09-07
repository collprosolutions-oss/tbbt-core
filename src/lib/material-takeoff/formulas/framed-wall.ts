/**
 * Simple framed-wall takeoff: studs, plates, optional sheathing and
 * fastener allowance. Openings add king/jack studs conservatively and
 * do not attempt a full opening schedule.
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
  parsePositiveConstructionNumber,
  parsePositiveNumber,
  resolveFeetInchesInput,
  roundTakeoff,
} from "@/lib/material-takeoff/units";

export const FRAMED_WALL_TAKEOFF_ID = "framed-wall" as const;

export const DEFAULT_STUD_SPACING_IN = 16;
export const DEFAULT_PLATE_BOARD_LENGTH_FT = 8;
export const DEFAULT_FRAMED_WALL_WASTE_PERCENT = 10;
export const DEFAULT_SHEATHING_SHEET_SQ_FT = 32;
export const EXTRA_STUDS_PER_OPENING = 4;

export type FramedWallInputs = {
  wallLengthFt: number;
  wallHeightFt: number;
  wallLengthFtPart: number;
  wallLengthInPart: number;
  wallHeightFtPart: number;
  wallHeightInPart: number;
  studSpacingIn: number;
  openings: number;
  plateBoardLengthFt: number;
  includeSheathing: boolean;
  includeFasteners: boolean;
  includePickup: boolean;
};

export function emptyFramedWallInputs(
  partial?: Record<string, unknown> | null,
): FramedWallInputs {
  const wallLength = resolveFeetInchesInput(
    partial,
    "wallLengthFt",
    "wallLengthFtPart",
    "wallLengthInPart",
  );
  const fallbackLength =
    wallLength.totalFt > 0
      ? wallLength
      : resolveFeetInchesInput(partial, "wallWidthFt", "wallWidthFtPart", "wallWidthInPart");
  const length =
    fallbackLength.totalFt > 0
      ? fallbackLength
      : resolveFeetInchesInput(partial, "lengthFt", "lengthFtPart", "lengthInPart");
  const wallHeight = resolveFeetInchesInput(
    partial,
    "wallHeightFt",
    "wallHeightFtPart",
    "wallHeightInPart",
  );
  return {
    wallLengthFt: length.totalFt,
    wallHeightFt: wallHeight.totalFt,
    wallLengthFtPart: length.feetPart,
    wallLengthInPart: length.inchesPart,
    wallHeightFtPart: wallHeight.feetPart,
    wallHeightInPart: wallHeight.inchesPart,
    studSpacingIn:
      parsePositiveConstructionNumber(partial?.studSpacingIn) ??
      parsePositiveNumber(partial?.studSpacingIn) ??
      DEFAULT_STUD_SPACING_IN,
    openings: Math.max(
      0,
      Math.floor(parseNonNegativeNumber(partial?.openings) ?? 0),
    ),
    plateBoardLengthFt:
      parsePositiveNumber(partial?.plateBoardLengthFt) ??
      DEFAULT_PLATE_BOARD_LENGTH_FT,
    includeSheathing: partial?.includeSheathing === true,
    includeFasteners: partial?.includeFasteners === true,
    includePickup: partial?.includePickup !== false,
  };
}

export function framedWallStudCount(lengthFt: number, spacingIn: number) {
  if (lengthFt <= 0 || spacingIn <= 0) return 0;
  return Math.floor((lengthFt * 12) / spacingIn) + 1;
}

export function framedWallPlateBoards(
  lengthFt: number,
  boardLengthFt: number,
  wastePercent: number,
) {
  if (lengthFt <= 0 || boardLengthFt <= 0) return 0;
  const linear = lengthFt * 3 * (1 + Math.max(0, wastePercent) / 100);
  return ceilCount(linear / boardLengthFt);
}

export function computeFramedWallTakeoff(input: {
  inputs?: Record<string, unknown> | null;
  wastePercent?: number;
  measurementSource?: TakeoffSnapshot["measurementSource"];
  skippedMeasurements?: string[];
}): { snapshot: TakeoffSnapshot; rejected: string | null } {
  const inputs = emptyFramedWallInputs(input.inputs);
  const wastePercent =
    parseNonNegativeNumber(input.wastePercent) ??
    DEFAULT_FRAMED_WALL_WASTE_PERCENT;
  if (inputs.wallLengthFt <= 0 || inputs.wallHeightFt <= 0) {
    return {
      snapshot: blankSnapshot(inputs, wastePercent, input),
      rejected: "Framed-wall takeoff needs wall length and height greater than 0.",
    };
  }
  if (inputs.studSpacingIn <= 0) {
    return {
      snapshot: blankSnapshot(inputs, wastePercent, input),
      rejected: "Framed-wall takeoff needs stud spacing greater than 0.",
    };
  }

  const layoutStuds = framedWallStudCount(inputs.wallLengthFt, inputs.studSpacingIn);
  const openingStuds = inputs.openings * EXTRA_STUDS_PER_OPENING;
  const studWaste = ceilCount(layoutStuds * (Math.max(0, wastePercent) / 100));
  const studs = layoutStuds + openingStuds + studWaste;
  const plates = framedWallPlateBoards(
    inputs.wallLengthFt,
    inputs.plateBoardLengthFt,
    wastePercent,
  );
  const wallArea = roundTakeoff(inputs.wallLengthFt * inputs.wallHeightFt, 4);
  const sheathing = ceilCount(
    (wallArea * (1 + Math.max(0, wastePercent) / 100)) /
      DEFAULT_SHEATHING_SHEET_SQ_FT,
  );
  const fastenerBoxes = Math.max(1, ceilCount(studs / 20));

  const explanation =
    `${formatFeetInches(inputs.wallLengthFt)} wall @ ${inputs.studSpacingIn}" OC → ${layoutStuds} layout studs` +
    (openingStuds
      ? ` + ${openingStuds} king/jack studs for ${inputs.openings} opening(s)`
      : "") +
    (studWaste ? ` + ${studWaste} waste` : "") +
    ` = ${studs} studs. Bottom + double top plates → ${plates} ${inputs.plateBoardLengthFt}-ft boards.`;

  const items: TakeoffItem[] = [
    item({
      id: "studs",
      kind: "studs",
      label: "Studs",
      unit: "ea",
      optional: false,
      selected: true,
      calculatedQuantity: studs,
      explanation: `floor(${inputs.wallLengthFt} ft × 12 / ${inputs.studSpacingIn}") + 1, plus openings and waste.`,
    }),
    item({
      id: "plates",
      kind: "plates",
      label: `${inputs.plateBoardLengthFt}-ft top/bottom plates`,
      unit: "ea",
      optional: false,
      selected: true,
      calculatedQuantity: plates,
      explanation: `3 × ${inputs.wallLengthFt} ft with ${wastePercent}% waste ÷ ${inputs.plateBoardLengthFt} ft boards.`,
    }),
    item({
      id: "sheathing",
      kind: "sheathing",
      label: "Sheathing / 4×8 sheets",
      unit: "sheet",
      optional: true,
      selected: inputs.includeSheathing,
      calculatedQuantity: sheathing,
      explanation: `${wallArea} sq ft × waste ÷ ${DEFAULT_SHEATHING_SHEET_SQ_FT} sq ft/sheet, rounded up.`,
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
        "Editable allowance (about 1 box per 20 studs). Not a counted fastener list.",
    }),
    pickupItem(inputs.includePickup),
  ];

  return {
    rejected: null,
    snapshot: {
      version: 1,
      takeoffType: FRAMED_WALL_TAKEOFF_ID,
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
  inputs: FramedWallInputs,
  wastePercent: number,
  input: {
    measurementSource?: TakeoffSnapshot["measurementSource"];
    skippedMeasurements?: string[];
  },
): TakeoffSnapshot {
  return {
    version: 1,
    takeoffType: FRAMED_WALL_TAKEOFF_ID,
    inputs: { ...inputs },
    wastePercent,
    markupPercent: 0,
    measurementSource: input.measurementSource ?? null,
    explanation: `${TAKEOFF_TYPE_LABELS[FRAMED_WALL_TAKEOFF_ID]} needs wall length and height before quantities can be calculated.`,
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

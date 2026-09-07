/**
 * Small residential concrete slab takeoff.
 *
 * Volume comes from length × width × thickness. Bag count uses the
 * selected bag yield (60-lb default = 0.45 cu ft), not a hard-coded bag
 * count or a locked job rate. Unusual excavation, demolition, pumping,
 * thickened edges, and access extras stay out of this base math.
 */
import {
  TAKEOFF_TYPE_LABELS,
  type TakeoffItem,
  type TakeoffSnapshot,
} from "@/lib/material-takeoff/types";
import {
  ceilCount,
  parseNonNegativeNumber,
  parsePositiveNumber,
  roundTakeoff,
} from "@/lib/material-takeoff/units";

export const CONCRETE_SLAB_TAKEOFF_ID = "concrete-slab" as const;

/** Published bag yields (cu ft) for common sacked concrete. */
export const CONCRETE_BAG_YIELDS_CU_FT: Record<40 | 60 | 80, number> = {
  40: 0.3,
  60: 0.45,
  80: 0.6,
};

export const DEFAULT_CONCRETE_BAG_SIZE_LB = 60;
export const DEFAULT_CONCRETE_BAG_YIELD_CU_FT =
  CONCRETE_BAG_YIELDS_CU_FT[DEFAULT_CONCRETE_BAG_SIZE_LB];
export const DEFAULT_CONCRETE_WASTE_PERCENT = 10;
export const DEFAULT_SLAB_THICKNESS_IN = 4;
export const DEFAULT_FORM_BOARD_LENGTH_FT = 8;
export const DEFAULT_STAKE_SPACING_FT = 3;
export const DEFAULT_MESH_SHEET_SQ_FT = 50;
export const DEFAULT_ANCHOR_SPACING_FT = 6;

export type ConcreteSlabInputs = {
  lengthFt: number;
  widthFt: number;
  thicknessIn: number;
  bagSizeLb: number;
  bagYieldCuFt: number;
  formBoardLengthFt: number;
  stakeSpacingFt: number;
  meshSheetSqFt: number;
  includeWireMesh: boolean;
  includeFormLumber: boolean;
  includeAnchors: boolean;
  includeSillGasket: boolean;
  includePickup: boolean;
};

export function emptyConcreteSlabInputs(
  partial?: Record<string, unknown> | null,
): ConcreteSlabInputs {
  const bagSize =
    parsePositiveNumber(partial?.bagSizeLb) ?? DEFAULT_CONCRETE_BAG_SIZE_LB;
  const knownYield =
    bagSize === 40 || bagSize === 60 || bagSize === 80
      ? CONCRETE_BAG_YIELDS_CU_FT[bagSize]
      : DEFAULT_CONCRETE_BAG_YIELD_CU_FT;
  return {
    lengthFt: parsePositiveNumber(partial?.lengthFt) ?? 0,
    widthFt: parsePositiveNumber(partial?.widthFt) ?? 0,
    thicknessIn:
      parsePositiveNumber(partial?.thicknessIn) ?? DEFAULT_SLAB_THICKNESS_IN,
    bagSizeLb: bagSize,
    bagYieldCuFt: parsePositiveNumber(partial?.bagYieldCuFt) ?? knownYield,
    formBoardLengthFt:
      parsePositiveNumber(partial?.formBoardLengthFt) ??
      DEFAULT_FORM_BOARD_LENGTH_FT,
    stakeSpacingFt:
      parsePositiveNumber(partial?.stakeSpacingFt) ?? DEFAULT_STAKE_SPACING_FT,
    meshSheetSqFt:
      parsePositiveNumber(partial?.meshSheetSqFt) ?? DEFAULT_MESH_SHEET_SQ_FT,
    includeWireMesh: partial?.includeWireMesh !== false,
    includeFormLumber: partial?.includeFormLumber !== false,
    includeAnchors: partial?.includeAnchors === true,
    includeSillGasket: partial?.includeSillGasket === true,
    includePickup: partial?.includePickup !== false,
  };
}

export function concreteVolumeCuFt(input: ConcreteSlabInputs) {
  if (input.lengthFt <= 0 || input.widthFt <= 0 || input.thicknessIn <= 0) {
    return 0;
  }
  return roundTakeoff(input.lengthFt * input.widthFt * (input.thicknessIn / 12), 4);
}

export function concreteBagsRequired(
  volumeCuFt: number,
  wastePercent: number,
  bagYieldCuFt: number,
) {
  if (volumeCuFt <= 0 || bagYieldCuFt <= 0) return 0;
  const waste = Math.max(0, wastePercent) / 100;
  return ceilCount((volumeCuFt * (1 + waste)) / bagYieldCuFt);
}

export function computeConcreteSlabTakeoff(input: {
  inputs?: Record<string, unknown> | null;
  wastePercent?: number;
  measurementSource?: TakeoffSnapshot["measurementSource"];
  skippedMeasurements?: string[];
}): { snapshot: TakeoffSnapshot; rejected: string | null } {
  const inputs = emptyConcreteSlabInputs(input.inputs);
  const wastePercent =
    parseNonNegativeNumber(input.wastePercent) ?? DEFAULT_CONCRETE_WASTE_PERCENT;
  if (inputs.lengthFt <= 0 || inputs.widthFt <= 0) {
    return {
      snapshot: blankSnapshot(inputs, wastePercent, input),
      rejected: "Concrete slab takeoff needs length and width greater than 0.",
    };
  }
  if (inputs.thicknessIn <= 0) {
    return {
      snapshot: blankSnapshot(inputs, wastePercent, input),
      rejected: "Concrete slab takeoff needs a thickness greater than 0.",
    };
  }
  if (inputs.bagYieldCuFt <= 0) {
    return {
      snapshot: blankSnapshot(inputs, wastePercent, input),
      rejected: "Enter a bag yield in cubic feet greater than 0.",
    };
  }

  const volumeCuFt = concreteVolumeCuFt(inputs);
  const volumeWithWaste = roundTakeoff(
    volumeCuFt * (1 + Math.max(0, wastePercent) / 100),
    4,
  );
  const bags = concreteBagsRequired(
    volumeCuFt,
    wastePercent,
    inputs.bagYieldCuFt,
  );
  const areaSqFt = roundTakeoff(inputs.lengthFt * inputs.widthFt, 4);
  const perimeterFt = roundTakeoff(2 * (inputs.lengthFt + inputs.widthFt), 4);
  const formBoards = ceilCount(perimeterFt / inputs.formBoardLengthFt);
  const stakes = Math.max(4, ceilCount(perimeterFt / inputs.stakeSpacingFt));
  const meshSheets = ceilCount(
    (areaSqFt * (1 + Math.max(0, wastePercent) / 100)) / inputs.meshSheetSqFt,
  );
  const anchors = Math.max(4, ceilCount(perimeterFt / DEFAULT_ANCHOR_SPACING_FT));
  const gasketLf = ceilCount(perimeterFt);

  const explanation =
    `${inputs.lengthFt} ft × ${inputs.widthFt} ft × ${inputs.thicknessIn} in ` +
    `= ${volumeCuFt} cu ft. ${wastePercent}% waste → ${volumeWithWaste} cu ft. ` +
    `${inputs.bagSizeLb}-lb bags @ ${inputs.bagYieldCuFt} cu ft each → ${bags} bags (rounded up). ` +
    `Unit costs are owner-entered; no locked job rate is applied.`;

  const items: TakeoffItem[] = [
    item({
      id: "concrete-bags",
      kind: "concrete-bags",
      label: `${inputs.bagSizeLb}-lb concrete bags`,
      unit: "bag",
      optional: false,
      selected: true,
      calculatedQuantity: bags,
      explanation:
        `${volumeWithWaste} cu ft ÷ ${inputs.bagYieldCuFt} cu ft/bag, rounded up.`,
    }),
    item({
      id: "wire-mesh",
      kind: "wire-mesh",
      label: "Welded wire mesh sheets",
      unit: "sheet",
      optional: true,
      selected: inputs.includeWireMesh,
      calculatedQuantity: meshSheets,
      explanation: `${areaSqFt} sq ft coverage ÷ ${inputs.meshSheetSqFt} sq ft/sheet, with waste, rounded up.`,
    }),
    item({
      id: "form-lumber",
      kind: "form-lumber",
      label: `${inputs.formBoardLengthFt}-ft form boards`,
      unit: "ea",
      optional: true,
      selected: inputs.includeFormLumber,
      calculatedQuantity: formBoards,
      explanation: `${perimeterFt} ft perimeter ÷ ${inputs.formBoardLengthFt} ft boards, rounded up.`,
    }),
    item({
      id: "form-stakes",
      kind: "form-stakes",
      label: "Form stakes / pins",
      unit: "ea",
      optional: true,
      selected: inputs.includeFormLumber,
      calculatedQuantity: stakes,
      explanation: `${perimeterFt} ft perimeter ÷ ${inputs.stakeSpacingFt} ft spacing, minimum 4.`,
    }),
    item({
      id: "anchor-hardware",
      kind: "anchor-hardware",
      label: "Anchor bolts / hardware",
      unit: "ea",
      optional: true,
      selected: inputs.includeAnchors,
      calculatedQuantity: anchors,
      explanation: `${perimeterFt} ft perimeter ÷ ${DEFAULT_ANCHOR_SPACING_FT} ft spacing, minimum 4.`,
    }),
    item({
      id: "sill-gasket",
      kind: "sill-gasket",
      label: "Sill gasket",
      unit: "lf",
      optional: true,
      selected: inputs.includeSillGasket,
      calculatedQuantity: gasketLf,
      explanation: `${perimeterFt} ft perimeter, rounded up to whole feet.`,
    }),
    pickupItem(inputs.includePickup),
  ];

  return {
    rejected: null,
    snapshot: {
      version: 1,
      takeoffType: CONCRETE_SLAB_TAKEOFF_ID,
      inputs: { ...inputs },
      wastePercent,
      measurementSource: input.measurementSource ?? null,
      explanation,
      skippedMeasurements: input.skippedMeasurements ?? [],
      removedItemIds: [],
      items,
    },
  };
}

function blankSnapshot(
  inputs: ConcreteSlabInputs,
  wastePercent: number,
  input: {
    measurementSource?: TakeoffSnapshot["measurementSource"];
    skippedMeasurements?: string[];
  },
): TakeoffSnapshot {
  return {
    version: 1,
    takeoffType: CONCRETE_SLAB_TAKEOFF_ID,
    inputs: { ...inputs },
    wastePercent,
    measurementSource: input.measurementSource ?? null,
    explanation: `${TAKEOFF_TYPE_LABELS[CONCRETE_SLAB_TAKEOFF_ID]} needs dimensions before quantities can be calculated.`,
    skippedMeasurements: input.skippedMeasurements ?? [],
    removedItemIds: [],
    items: [],
  };
}

function item(
  value: Omit<TakeoffItem, "quantityOverride" | "unitCost" | "convertedLineItemId">,
): TakeoffItem {
  return {
    ...value,
    quantityOverride: null,
    unitCost: null,
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

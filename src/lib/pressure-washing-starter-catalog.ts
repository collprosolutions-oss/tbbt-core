/**
 * Pressure Washing starter catalog templates.
 *
 * Per-business copies after import — not a shared live price list and not
 * nationwide prices. Amounts are configurable starting-at defaults only.
 * Installing this catalog must never insert rows into a Handyman-only or
 * Cleaning-only business.
 *
 * This is a small launch pack. Grouping uses the persisted
 * ServiceCatalogItem.category column plus
 * preferredCatalogCategoryOrder("PRESSURE_WASHING") — this file is not a
 * second catalog engine.
 */

export const PRESSURE_WASHING_STARTER_PRICE_NOTE =
  "Starter default you can edit — not a market claim.";

export const PRESSURE_WASHING_CATALOG_CATEGORIES = [
  "House Exterior",
  "Concrete & Hardscape",
  "Decks & Fences",
  "Roof & Gutters",
  "Commercial",
  "Custom Pressure Washing",
] as const;

export type PressureWashingCatalogCategory =
  (typeof PRESSURE_WASHING_CATALOG_CATEGORIES)[number];

export type PressureWashingStarterService = {
  templateKey: string;
  category: PressureWashingCatalogCategory;
  name: string;
  description: string;
  startingPrice: number | null;
  pricingMode?: "FIXED" | "STARTING_AT" | "CUSTOM_QUOTE";
  recurrenceEligible?: boolean;
  unitLabel?: string;
};

export const PRESSURE_WASHING_STARTER_SERVICES: PressureWashingStarterService[] = [
  {
    templateKey: "house-wash",
    category: "House Exterior",
    name: "House Wash",
    startingPrice: 249,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Soft wash of typical house siding, trim, and reachable exterior surfaces. Stories, surfaces, and stains are collected at intake. " +
      PRESSURE_WASHING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "soft-wash-exterior",
    category: "House Exterior",
    name: "Soft Wash Exterior",
    startingPrice: 299,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Low-pressure exterior wash for painted siding or surfaces that should not take a hard blast. Height and soil still change the work. " +
      PRESSURE_WASHING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "driveway-cleaning",
    category: "Concrete & Hardscape",
    name: "Driveway Cleaning",
    startingPrice: 129,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Concrete driveway rinse and surface clean. Oil stains or heavy soil may need a separate treatment or custom quote. " +
      PRESSURE_WASHING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "sidewalk-walkway-cleaning",
    category: "Concrete & Hardscape",
    name: "Sidewalk / Walkway Cleaning",
    startingPrice: 89,
    pricingMode: "FIXED",
    recurrenceEligible: true,
    description:
      "Typical sidewalk or walkway surface clean. Long runs or oil stains are not assumed. " +
      PRESSURE_WASHING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "patio-pool-deck-cleaning",
    category: "Concrete & Hardscape",
    name: "Patio / Pool Deck Cleaning",
    startingPrice: 149,
    pricingMode: "STARTING_AT",
    recurrenceEligible: false,
    description:
      "Patio or pool-deck surface clean. Pavers, sealed concrete, and algae coverage still change the visit. " +
      PRESSURE_WASHING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "deck-cleaning",
    category: "Decks & Fences",
    name: "Deck Cleaning",
    startingPrice: 179,
    pricingMode: "STARTING_AT",
    recurrenceEligible: false,
    description:
      "Wood or composite deck surface clean. Size, railings, and stain prep can be described in the request. " +
      PRESSURE_WASHING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "fence-cleaning",
    category: "Decks & Fences",
    name: "Fence Cleaning",
    startingPrice: 159,
    pricingMode: "STARTING_AT",
    recurrenceEligible: false,
    description:
      "Fence panel clean for typical wood or vinyl runs. Length and both-side washing still change the owner-set price. " +
      PRESSURE_WASHING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "roof-soft-wash",
    category: "Roof & Gutters",
    name: "Roof Soft Wash",
    startingPrice: null,
    pricingMode: "CUSTOM_QUOTE",
    recurrenceEligible: false,
    description:
      "Low-pressure roof wash. Pitch, material, and access vary too widely for a safe public price.",
  },
  {
    templateKey: "gutter-exterior-cleaning",
    category: "Roof & Gutters",
    name: "Gutter Exterior Cleaning",
    startingPrice: 99,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Exterior gutter face clean. Interior gutter clearing is not assumed unless the customer describes that work. " +
      PRESSURE_WASHING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "storefront-exterior",
    category: "Commercial",
    name: "Storefront Exterior",
    startingPrice: null,
    pricingMode: "CUSTOM_QUOTE",
    recurrenceEligible: false,
    description:
      "Storefront or small building exterior wash. Hours, water access, and adjacent traffic need a custom quote.",
  },
  {
    templateKey: "oil-stain-treatment",
    category: "Concrete & Hardscape",
    name: "Oil Stain Treatment",
    startingPrice: null,
    pricingMode: "CUSTOM_QUOTE",
    recurrenceEligible: false,
    description:
      "Spot treatment for oil or similar stains on concrete. Age and penetration of the stain need a custom quote.",
  },
  {
    templateKey: "custom-pressure-washing-quote",
    category: "Custom Pressure Washing",
    name: "Custom Pressure Washing Quote",
    startingPrice: null,
    pricingMode: "CUSTOM_QUOTE",
    recurrenceEligible: false,
    description:
      "Surfaces, buildings, or conditions that do not fit a listed wash. Water access, stains, and visit type stay on the request.",
  },
];

export function catalogNameKey(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function pressureWashingStarterPricingMode(
  service: PressureWashingStarterService,
) {
  if (service.pricingMode) return service.pricingMode;
  return service.startingPrice == null ? "CUSTOM_QUOTE" : "STARTING_AT";
}

export function planPressureWashingStarterCatalogInstall(existingNames: string[]) {
  const existing = new Set(existingNames.map(catalogNameKey));
  const add: PressureWashingStarterService[] = [];
  const skip: PressureWashingStarterService[] = [];
  for (const service of PRESSURE_WASHING_STARTER_SERVICES) {
    if (existing.has(catalogNameKey(service.name))) {
      skip.push(service);
    } else {
      add.push(service);
    }
  }
  return { add, skip, pending: [] as PressureWashingStarterService[] };
}

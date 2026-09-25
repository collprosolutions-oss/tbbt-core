/**
 * Cleaning starter catalog templates.
 *
 * Per-business copies after import — not a shared live price list and not
 * nationwide prices. Amounts are configurable starting-at defaults only.
 * Installing this catalog must never insert rows into a Handyman-only
 * business.
 */

export const CLEANING_CATALOG_CATEGORIES = [
  "Standard Cleaning",
  "Deep Cleaning",
  "Move-In / Move-Out",
  "Add-Ons",
  "Custom Cleaning",
] as const;

export type CleaningCatalogCategory =
  (typeof CLEANING_CATALOG_CATEGORIES)[number];

export type CleaningStarterService = {
  templateKey: string;
  category: CleaningCatalogCategory;
  name: string;
  description: string;
  startingPrice: number | null;
  pricingMode?: "FIXED" | "STARTING_AT" | "VARIABLE" | "CUSTOM_QUOTE";
  recurrenceEligible?: boolean;
  unitLabel?: string;
};

export const CLEANING_STARTER_SERVICES: CleaningStarterService[] = [
  {
    templateKey: "standard-clean",
    category: "Standard Cleaning",
    name: "Standard Clean",
    startingPrice: 140,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Recurring-ready whole-home clean of kitchens, bathrooms, floors, and common surfaces. Starting price is a local template only — owners set their own rate. Bedroom and bathroom counts are collected at intake.",
  },
  {
    templateKey: "deep-clean",
    category: "Deep Cleaning",
    name: "Deep Clean",
    startingPrice: 240,
    pricingMode: "STARTING_AT",
    recurrenceEligible: false,
    description:
      "Detailed clean including baseboards, extra kitchen and bath attention, and built-up soil. Starting price is a configurable template, not a nationwide rate. Larger homes or heavy soil need a custom quote.",
  },
  {
    templateKey: "move-in-move-out-clean",
    category: "Move-In / Move-Out",
    name: "Move-In / Move-Out Clean",
    startingPrice: null,
    pricingMode: "CUSTOM_QUOTE",
    recurrenceEligible: false,
    description:
      "Empty-home or turnover clean. Scope varies with home size, condition, and add-ons, so this starter uses a custom quote instead of a rigid price.",
  },
  {
    templateKey: "bedroom-refresh",
    category: "Add-Ons",
    name: "Additional Bedroom",
    startingPrice: 25,
    pricingMode: "VARIABLE",
    recurrenceEligible: true,
    unitLabel: "bedroom",
    description:
      "Per-bedroom add-on when a visit includes extra bedrooms beyond the quoted home. Unit price is a local template.",
  },
  {
    templateKey: "bathroom-refresh",
    category: "Add-Ons",
    name: "Additional Bathroom",
    startingPrice: 30,
    pricingMode: "VARIABLE",
    recurrenceEligible: true,
    unitLabel: "bathroom",
    description:
      "Per-bathroom add-on when a visit includes extra bathrooms beyond the quoted home. Unit price is a local template.",
  },
  {
    templateKey: "inside-fridge",
    category: "Add-Ons",
    name: "Inside Fridge",
    startingPrice: 35,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Interior refrigerator wipe-down and shelf clean. Starting price is configurable.",
  },
  {
    templateKey: "inside-oven",
    category: "Add-Ons",
    name: "Inside Oven",
    startingPrice: 40,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Interior oven clean. Heavy baked-on soil may need a custom quote.",
  },
  {
    templateKey: "interior-windows",
    category: "Add-Ons",
    name: "Interior Windows",
    startingPrice: 60,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Interior glass and sill wipe. Count and access notes are collected at intake. Starting price is a local template.",
  },
  {
    templateKey: "laundry-addon",
    category: "Add-Ons",
    name: "Laundry",
    startingPrice: 25,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "One load of laundry started or folded when the customer provides supplies. Starting price is configurable.",
  },
  {
    templateKey: "custom-cleaning-quote",
    category: "Custom Cleaning",
    name: "Custom Cleaning Quote",
    startingPrice: null,
    pricingMode: "CUSTOM_QUOTE",
    recurrenceEligible: false,
    description:
      "Homes, offices, or conditions that do not fit a standard or deep clean. Pets, access notes, and frequency stay on the request.",
  },
];

export function catalogNameKey(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function cleaningStarterPricingMode(service: CleaningStarterService) {
  if (service.pricingMode) return service.pricingMode;
  return service.startingPrice == null ? "CUSTOM_QUOTE" : "STARTING_AT";
}

export function planCleaningStarterCatalogInstall(existingNames: string[]) {
  const existing = new Set(existingNames.map(catalogNameKey));
  const add: CleaningStarterService[] = [];
  const skip: CleaningStarterService[] = [];
  for (const service of CLEANING_STARTER_SERVICES) {
    if (existing.has(catalogNameKey(service.name))) {
      skip.push(service);
    } else {
      add.push(service);
    }
  }
  return { add, skip, pending: [] as CleaningStarterService[] };
}

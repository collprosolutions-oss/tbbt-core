/**
 * Cleaning starter catalog templates.
 *
 * Per-business copies after import — not a shared live price list and not
 * nationwide prices. Amounts are configurable starting-at defaults only.
 * Installing this catalog must never insert rows into a Handyman-only
 * business.
 *
 * Categories follow the Cleaning launch pack. Grouping on public and
 * workspace surfaces uses the persisted ServiceCatalogItem.category
 * column plus preferredCatalogCategoryOrder("CLEANING") — this file is
 * not a second catalog engine.
 */

export const CLEANING_STARTER_PRICE_NOTE =
  "Starter default you can edit — not a market claim.";

export const CLEANING_CATALOG_CATEGORIES = [
  "Recurring Cleaning",
  "One-Time Cleaning",
  "Deep Cleaning",
  "Move-In / Move-Out",
  "Vacation Rental / Turnover",
  "Kitchen Add-Ons",
  "Bathroom Add-Ons",
  "Interior Add-Ons",
  "Office / Small Commercial",
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
  pricingMode?: "FIXED" | "STARTING_AT" | "CUSTOM_QUOTE";
  recurrenceEligible?: boolean;
  unitLabel?: string;
};

export const CLEANING_STARTER_SERVICES: CleaningStarterService[] = [
  {
    templateKey: "standard-clean",
    category: "Recurring Cleaning",
    name: "Standard Clean",
    startingPrice: 140,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Recurring-ready whole-home clean of kitchens, bathrooms, floors, and common surfaces. Bedroom, bathroom, and size notes are collected at intake. Starting price is a local template only — owners set their own rate. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "recurring-maintenance-clean",
    category: "Recurring Cleaning",
    name: "Recurring Maintenance Clean",
    startingPrice: 120,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Scheduled upkeep for a home already on a regular clean. Frequency is collected at intake. Heavier soil or a first visit after a long gap may need a deep clean instead. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "one-time-home-cleaning",
    category: "One-Time Cleaning",
    name: "One-Time Home Cleaning",
    startingPrice: 160,
    pricingMode: "STARTING_AT",
    recurrenceEligible: false,
    description:
      "Single-visit home clean when the customer is not booking a recurring schedule. Size, occupancy, and condition are collected at intake. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "empty-home-refresh",
    category: "One-Time Cleaning",
    name: "Empty Home Refresh",
    startingPrice: 170,
    pricingMode: "STARTING_AT",
    recurrenceEligible: false,
    description:
      "One-time clean of a vacant home that is already in ordinary condition. Heavy soil, construction dust, or a move-out reset may need a custom quote. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "post-event-clean",
    category: "One-Time Cleaning",
    name: "Post-Event Clean",
    startingPrice: null,
    pricingMode: "CUSTOM_QUOTE",
    recurrenceEligible: false,
    description:
      "Cleanup after a gathering or short-term event. Scope depends on guest count, kitchen use, and leftover condition, so this starter uses a custom quote.",
  },
  {
    templateKey: "deep-clean",
    category: "Deep Cleaning",
    name: "Deep Clean",
    startingPrice: 240,
    pricingMode: "STARTING_AT",
    recurrenceEligible: false,
    description:
      "Detailed clean including baseboards, extra kitchen and bath attention, and built-up soil. Larger homes or heavy soil need a custom quote. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "heavy-soil-deep-clean",
    category: "Deep Cleaning",
    name: "Heavy Soil Deep Clean",
    startingPrice: null,
    pricingMode: "CUSTOM_QUOTE",
    recurrenceEligible: false,
    description:
      "Homes with neglected soil, strong odor, or extra buildup that a standard deep clean cannot safely price from basic intake.",
  },
  {
    templateKey: "move-in-cleaning",
    category: "Move-In / Move-Out",
    name: "Move-In Cleaning",
    startingPrice: 220,
    pricingMode: "STARTING_AT",
    recurrenceEligible: false,
    description:
      "Empty-home clean before new occupants arrive. Cabinets, appliances, and leftover debris still change the work, so owners should edit this default. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "move-out-cleaning",
    category: "Move-In / Move-Out",
    name: "Move-Out Cleaning",
    startingPrice: null,
    pricingMode: "CUSTOM_QUOTE",
    recurrenceEligible: false,
    description:
      "Move-out reset. Leftover belongings, appliance interiors, and landlord checklists vary too widely for a safe public price.",
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
    templateKey: "vacation-rental-turnover",
    category: "Vacation Rental / Turnover",
    name: "Vacation Rental Turnover",
    startingPrice: 180,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Guest-change clean for a short-term rental. Linens are only included when that add-on or service is selected. Same-day or extra-dirty stays may need a custom quote. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "same-day-turnover",
    category: "Vacation Rental / Turnover",
    name: "Same-Day Turnover",
    startingPrice: null,
    pricingMode: "CUSTOM_QUOTE",
    recurrenceEligible: false,
    description:
      "Same-day guest changeover. Timing, laundry, and condition cannot be priced safely from basic intake.",
  },
  {
    templateKey: "small-office-cleaning",
    category: "Office / Small Commercial",
    name: "Small Office Cleaning",
    startingPrice: 150,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Small office or studio clean. Desk count, restrooms, and after-hours access still change the visit. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "after-hours-office-cleaning",
    category: "Office / Small Commercial",
    name: "After-Hours Office Cleaning",
    startingPrice: null,
    pricingMode: "CUSTOM_QUOTE",
    recurrenceEligible: true,
    description:
      "Office cleaning that must happen outside normal business hours. Access, alarm, and suite size need a custom quote.",
  },
  {
    templateKey: "inside-fridge",
    category: "Kitchen Add-Ons",
    name: "Inside Fridge",
    startingPrice: 35,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Interior refrigerator wipe-down and shelf clean. Heavy spills may need a custom quote. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "inside-oven",
    category: "Kitchen Add-Ons",
    name: "Inside Oven",
    startingPrice: 40,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Interior oven clean. Heavy baked-on soil may need a custom quote. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "inside-cabinets",
    category: "Kitchen Add-Ons",
    name: "Inside Cabinets",
    startingPrice: 45,
    pricingMode: "STARTING_AT",
    recurrenceEligible: false,
    description:
      "Interior cabinet wipe when shelves are emptied or lightly loaded. Full unpacking is not assumed. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "cabinet-front-cleaning",
    category: "Kitchen Add-Ons",
    name: "Cabinet-Front Cleaning",
    startingPrice: 35,
    pricingMode: "FIXED",
    recurrenceEligible: true,
    description:
      "Wipe kitchen cabinet fronts and handles. Does not include interiors. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "kitchen-appliance-exterior",
    category: "Kitchen Add-Ons",
    name: "Kitchen Appliance Exterior",
    startingPrice: 25,
    pricingMode: "FIXED",
    recurrenceEligible: true,
    description:
      "Exterior wipe of typical kitchen appliances. Interiors are separate add-ons. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "bathroom-refresh",
    category: "Bathroom Add-Ons",
    name: "Additional Bathroom",
    startingPrice: 30,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    unitLabel: "bathroom",
    description:
      "Per-bathroom add-on when a visit includes extra bathrooms beyond the quoted home. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "shower-tub-detail",
    category: "Bathroom Add-Ons",
    name: "Shower / Tub Detail",
    startingPrice: 30,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Extra attention on one shower or tub beyond a standard bathroom wipe. Heavy scale may need a custom quote. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "bedroom-refresh",
    category: "Interior Add-Ons",
    name: "Additional Bedroom",
    startingPrice: 25,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    unitLabel: "bedroom",
    description:
      "Per-bedroom add-on when a visit includes extra bedrooms beyond the quoted home. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "interior-windows",
    category: "Interior Add-Ons",
    name: "Interior Windows",
    startingPrice: 60,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Interior glass and sill wipe. Scope and access can be described in the request. Exterior glass is not included. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "baseboard-detail",
    category: "Interior Add-Ons",
    name: "Baseboard Detail",
    startingPrice: 40,
    pricingMode: "STARTING_AT",
    recurrenceEligible: false,
    description:
      "Detail wipe of interior baseboards. Long runs or heavy dust may increase the owner-set price. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "blinds-dusting",
    category: "Interior Add-Ons",
    name: "Blinds Dusting",
    startingPrice: 35,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "Dust typical interior blinds. Heavy soil, fabric shades, or many rooms may need a custom quote. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "laundry-addon",
    category: "Interior Add-Ons",
    name: "Laundry",
    startingPrice: 25,
    pricingMode: "STARTING_AT",
    recurrenceEligible: true,
    description:
      "One load of laundry started or folded when the customer provides supplies. Only offered when this service is selected. " +
      CLEANING_STARTER_PRICE_NOTE,
  },
  {
    templateKey: "linen-change",
    category: "Interior Add-Ons",
    name: "Linen Change",
    startingPrice: 25,
    pricingMode: "FIXED",
    recurrenceEligible: true,
    description:
      "Remake beds with customer-supplied linens. Only offered when this service is selected. Laundry of those linens is a separate add-on. " +
      CLEANING_STARTER_PRICE_NOTE,
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

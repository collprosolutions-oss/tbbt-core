/**
 * Handyman starter catalog templates.
 * These are per-business copies after import, not a shared live price list.
 * Services without an approved startingPrice are listed but not imported.
 */

export const HANDYMAN_CATALOG_CATEGORIES = [
  "Doors & Locks",
  "Walls & Drywall",
  "Mounting & Hanging",
  "Fans & Fixtures",
  "Furniture & Assembly",
  "Trim & Carpentry",
  "Exterior Repairs",
  "Caulking & Sealing",
  "General Home Repairs",
  "Safety / Accessibility",
  "Punch Lists / Small Jobs",
] as const;

export type HandymanCatalogCategory =
  (typeof HANDYMAN_CATALOG_CATEGORIES)[number];

export type HandymanStarterService = {
  templateKey: string;
  category: HandymanCatalogCategory;
  name: string;
  description: string;
  startingPrice: number | null;
};

export const HANDYMAN_STARTER_SERVICES: HandymanStarterService[] = [
  {
    templateKey: "ceiling-fan-replacement",
    category: "Fans & Fixtures",
    name: "Ceiling Fan Replacement",
    startingPrice: 150,
    description:
      "Remove an existing standard ceiling fan and install a customer-supplied replacement using the existing approved fan-rated box and existing wiring. Additional charges may apply for high ceilings, troubleshooting, incompatible mounting conditions, specialty fans, or unusual conditions.",
  },
  {
    templateKey: "door-lock-deadbolt-installation",
    category: "Doors & Locks",
    name: "Door Lock / Deadbolt Installation",
    startingPrice: null,
    description:
      "Install a customer-supplied lock or deadbolt in an existing door prep. Additional charges may apply for new bore holes, strike-plate work, or unusual door conditions.",
  },
  {
    templateKey: "tv-mounting",
    category: "Mounting & Hanging",
    name: "TV Mounting",
    startingPrice: null,
    description:
      "Mount a customer-supplied TV on a suitable interior wall using a customer-supplied mount. Additional charges may apply for wiring concealment, stud issues, or oversized TVs.",
  },
  {
    templateKey: "drywall-repair",
    category: "Walls & Drywall",
    name: "Drywall Repair",
    startingPrice: null,
    description:
      "Patch small interior drywall damage and prepare the area for paint. Additional charges may apply for large holes, texture matching, or water damage.",
  },
  {
    templateKey: "interior-door-repair",
    category: "Doors & Locks",
    name: "Interior Door Repair",
    startingPrice: null,
    description:
      "Repair a sticking, sagging, or latching interior door using the existing slab and hardware when possible. Additional charges may apply for replacement parts or frame damage.",
  },
];

export function catalogNameKey(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function importableStarterServices() {
  return HANDYMAN_STARTER_SERVICES.filter(
    (service): service is HandymanStarterService & { startingPrice: number } =>
      service.startingPrice != null,
  );
}

export function pendingStarterServices() {
  return HANDYMAN_STARTER_SERVICES.filter(
    (service) => service.startingPrice == null,
  );
}

export function planStarterCatalogInstall(existingNames: string[]) {
  const existing = new Set(existingNames.map(catalogNameKey));
  const add: Array<HandymanStarterService & { startingPrice: number }> = [];
  const skip: Array<HandymanStarterService & { startingPrice: number }> = [];

  for (const service of importableStarterServices()) {
    if (existing.has(catalogNameKey(service.name))) {
      skip.push(service);
    } else {
      add.push(service);
    }
  }

  return {
    add,
    skip,
    pending: pendingStarterServices(),
  };
}

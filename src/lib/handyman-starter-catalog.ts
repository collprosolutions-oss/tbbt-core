/**
 * Handyman starter catalog templates.
 * These are per-business copies after import, not a shared live price list.
 * Starter prices are templates only. CUSTOM_QUOTE services import with no
 * dollar amount. Prices are labor recommendations, not hourly rates or materials.
 */

export const HANDYMAN_CATALOG_CATEGORIES = [
  "Doors & Locks",
  "Mounting & Hanging",
  "Walls & Drywall",
  "Trim & Carpentry",
  "Bathroom / Caulking / Accessories",
  "Furniture & Assembly",
  "Exterior Repairs",
  "Cabinets / Kitchen",
  "Fans & Fixtures",
  "Punch Lists / Small Jobs",
  "General Home Repairs",
] as const;

export type HandymanCatalogCategory =
  (typeof HANDYMAN_CATALOG_CATEGORIES)[number];

export type HandymanStarterService = {
  templateKey: string;
  category: HandymanCatalogCategory;
  name: string;
  description: string;
  startingPrice: number | null;
  pricingMode?: "FIXED" | "STARTING_AT" | "CUSTOM_QUOTE";
};

export const HANDYMAN_STARTER_SERVICES: HandymanStarterService[] = [
  {
    templateKey: "standard-door-knob-replacement",
    category: "Doors & Locks",
    name: "Standard Door Knob Replacement",
    startingPrice: 75,
    description:
      "Replace a standard interior or exterior door knob using the existing door prep and latch. Unusual bore sizes, strike-plate work, or damaged doors may increase the price.",
  },
  {
    templateKey: "deadbolt-replacement",
    category: "Doors & Locks",
    name: "Deadbolt Replacement",
    startingPrice: 75,
    description:
      "Replace a deadbolt in an existing door prep and strike. New bore holes, misaligned frames, or specialty locks may increase the price.",
  },
  {
    templateKey: "door-knob-deadbolt-set",
    category: "Doors & Locks",
    name: "Door Knob + Deadbolt Set",
    startingPrice: 125,
    description:
      "Replace a matching door knob and deadbolt set using existing preps. Extra drilling, frame repair, or keyed-alike work beyond a standard swap may increase the price.",
  },
  {
    templateKey: "keypad-electronic-deadbolt-replacement",
    category: "Doors & Locks",
    name: "Keypad / Electronic Deadbolt Replacement",
    startingPrice: 100,
    description:
      "Replace a keypad or electronic deadbolt in an existing door prep using batteries and the existing opening. New wiring, smart-home hubs, or door damage may increase the price.",
  },
  {
    templateKey: "interior-door-adjustment",
    category: "Doors & Locks",
    name: "Interior Door Adjustment",
    startingPrice: 100,
    description:
      "Adjust a sticking, sagging, or poorly latching interior door using the existing slab and hardware. Replacement parts, frame damage, or a new door may increase the price.",
  },
  {
    templateKey: "exterior-door-adjustment",
    category: "Doors & Locks",
    name: "Exterior Door Adjustment",
    startingPrice: 125,
    description:
      "Adjust an exterior door so it opens, closes, and latches using the existing slab and hardware. Weather damage, frame repair, or replacement hardware may increase the price.",
  },
  {
    templateKey: "interior-door-replacement",
    category: "Doors & Locks",
    name: "Interior Door Replacement",
    startingPrice: 175,
    description:
      "Hang a standard interior door slab in an existing frame using typical hardware. Oversized doors, frame rebuilds, or finish work may increase the price. Door slab not included unless stated.",
  },
  {
    templateKey: "door-closer-installation-adjustment",
    category: "Doors & Locks",
    name: "Door Closer Installation / Adjustment",
    startingPrice: 100,
    description:
      "Install or adjust a standard door closer on an existing door. Specialty closers, damaged doors, or extra mounting plates may increase the price.",
  },
  {
    templateKey: "tv-mounting-up-to-55",
    category: "Mounting & Hanging",
    name: "TV Mounting Up to 55 Inches",
    startingPrice: 125,
    description:
      "Mount a customer-supplied TV up to 55 inches with a customer-supplied mount on a suitable interior wall. In-wall wiring, stud issues, or masonry walls may increase the price.",
  },
  {
    templateKey: "tv-mounting-56-75",
    category: "Mounting & Hanging",
    name: "TV Mounting 56–75 Inches",
    startingPrice: 150,
    description:
      "Mount a customer-supplied TV 56–75 inches with a customer-supplied mount on a suitable interior wall. Concealment, extra bracing, or masonry may increase the price.",
  },
  {
    templateKey: "tv-mounting-76-plus",
    category: "Mounting & Hanging",
    name: "TV Mounting 76+ Inches",
    startingPrice: 200,
    description:
      "Mount a customer-supplied TV 76 inches or larger with a customer-supplied mount on a suitable interior wall. Extra labor for weight, bracing, or difficult walls may increase the price.",
  },
  {
    templateKey: "curtain-rod-installation",
    category: "Mounting & Hanging",
    name: "Curtain Rod Installation",
    startingPrice: 75,
    description:
      "Install a standard curtain rod on an interior wall or trim. Extra-wide spans, masonry, or multiple windows beyond a typical single rod may increase the price.",
  },
  {
    templateKey: "blind-shade-installation",
    category: "Mounting & Hanging",
    name: "Blind / Shade Installation",
    startingPrice: 75,
    description:
      "Install a standard interior blind or shade in an existing window opening. Custom sizes, motorized units, or several openings may increase the price.",
  },
  {
    templateKey: "large-mirror-mounting",
    category: "Mounting & Hanging",
    name: "Large Mirror Mounting",
    startingPrice: 100,
    description:
      "Mount a large interior mirror with appropriate hardware on a suitable wall. Extra weight, masonry, or custom clips may increase the price.",
  },
  {
    templateKey: "shelving-installation",
    category: "Mounting & Hanging",
    name: "Shelving Installation",
    startingPrice: 100,
    description:
      "Install a standard wall shelf on a suitable interior wall. Long runs, masonry, or heavy-duty loading may increase the price.",
  },
  {
    templateKey: "picture-art-hanging",
    category: "Mounting & Hanging",
    name: "Picture / Art Hanging",
    startingPrice: 75,
    description:
      "Hang typical pictures or artwork on an interior wall. Gallery walls, masonry, or unusually heavy pieces may increase the price.",
  },
  {
    templateKey: "wall-mounted-accessory",
    category: "Mounting & Hanging",
    name: "Wall-Mounted Accessory",
    startingPrice: 75,
    description:
      "Install a typical wall-mounted accessory on a suitable interior wall. Masonry, wiring, or specialty hardware may increase the price.",
  },
  {
    templateKey: "small-drywall-patch-up-to-6",
    category: "Walls & Drywall",
    name: "Small Drywall Patch Up to Approx. 6 Inches",
    startingPrice: 125,
    description:
      "Patch a small interior drywall hole up to about 6 inches and leave it ready for paint. Texture matching, water damage, or larger holes may increase the price. Paint not included unless stated.",
  },
  {
    templateKey: "medium-drywall-repair",
    category: "Walls & Drywall",
    name: "Medium Drywall Repair",
    startingPrice: 175,
    description:
      "Repair a medium interior drywall area and leave it ready for paint. Large patches, texture matching, or moisture damage may increase the price. Paint not included unless stated.",
  },
  {
    templateKey: "large-drywall-repair",
    category: "Walls & Drywall",
    name: "Large Drywall Repair",
    startingPrice: 250,
    description:
      "Repair a large interior drywall area and leave it ready for paint. Multiple rooms, texture matching, or structural issues may increase the price. Paint not included unless stated.",
  },
  {
    templateKey: "minor-wall-ceiling-crack-repair",
    category: "Walls & Drywall",
    name: "Minor Wall / Ceiling Crack Repair",
    startingPrice: 125,
    description:
      "Repair a minor interior wall or ceiling crack and leave it ready for paint. Active settling, water damage, or long crack runs may increase the price.",
  },
  {
    templateKey: "small-hole-anchor-repairs",
    category: "Walls & Drywall",
    name: "Small Hole / Anchor Repairs",
    startingPrice: 100,
    description:
      "Fill small interior holes and failed anchors and leave the area ready for paint. Many holes, masonry, or large patches may increase the price.",
  },
  {
    templateKey: "baseboard-trim-repair",
    category: "Trim & Carpentry",
    name: "Baseboard / Trim Repair",
    startingPrice: 125,
    description:
      "Repair a section of interior baseboard or trim using typical materials. Long runs, custom profiles, or finish matching may increase the price.",
  },
  {
    templateKey: "small-wood-repair",
    category: "Trim & Carpentry",
    name: "Small Wood Repair",
    startingPrice: 125,
    description:
      "Repair a small area of interior wood trim or millwork. Rot, large replacement, or finish matching may increase the price.",
  },
  {
    templateKey: "closet-shelf-rod-repair",
    category: "Trim & Carpentry",
    name: "Closet Shelf / Rod Repair",
    startingPrice: 100,
    description:
      "Repair an existing closet shelf or rod using typical hardware. Full replacement, masonry walls, or custom millwork may increase the price.",
  },
  {
    templateKey: "closet-shelf-rod-installation",
    category: "Trim & Carpentry",
    name: "Closet Shelf / Rod Installation",
    startingPrice: 125,
    description:
      "Install a standard closet shelf and rod in an existing closet. Custom layouts, heavy-duty systems, or unusual walls may increase the price.",
  },
  {
    templateKey: "minor-molding-repair",
    category: "Trim & Carpentry",
    name: "Minor Molding Repair",
    startingPrice: 125,
    description:
      "Repair a small section of interior molding. Long runs, custom profiles, or finish matching may increase the price.",
  },
  {
    templateKey: "decorative-wall-paneling-finish-carpentry",
    category: "Trim & Carpentry",
    name: "Decorative Wall Paneling & Finish Carpentry",
    startingPrice: null,
    pricingMode: "CUSTOM_QUOTE",
    description:
      "Installation of decorative wall paneling, accent panels, trim, casing, build-outs, gable sections, transitions, and related finish carpentry. Pricing depends on wall dimensions, openings, material type and thickness, trim layout, access, preparation, cuts, and overall project complexity.",
  },
  {
    templateKey: "interior-trim-finish-carpentry",
    category: "Trim & Carpentry",
    name: "Interior Trim & Finish Carpentry",
    startingPrice: null,
    pricingMode: "CUSTOM_QUOTE",
    description:
      "Custom trim installation and repair including casing, baseboard, panel trim, transitions, build-ups, finish details, and other small custom carpentry projects. Final pricing depends on dimensions, materials, existing conditions, access, and finish complexity.",
  },
  {
    templateKey: "tub-shower-recaulk",
    category: "Bathroom / Caulking / Accessories",
    name: "Tub / Shower Recaulk",
    startingPrice: 150,
    description:
      "Remove failing caulk and recaulk a standard tub or shower using typical bathroom caulk. Tile repair, leaks behind the wall, or plumbing work are not included and may require a separate quote.",
  },
  {
    templateKey: "sink-countertop-recaulk",
    category: "Bathroom / Caulking / Accessories",
    name: "Sink / Countertop Recaulk",
    startingPrice: 100,
    description:
      "Recaulk a standard sink or countertop seam. Countertop replacement, plumbing leaks, or damaged substrate may increase the price.",
  },
  {
    templateKey: "toilet-paper-holder-towel-bar-installation",
    category: "Bathroom / Caulking / Accessories",
    name: "Toilet Paper Holder / Towel Bar Installation",
    startingPrice: 75,
    description:
      "Install a standard toilet paper holder or towel bar on a suitable bathroom wall. Masonry, blocking issues, or multiple pieces may increase the price.",
  },
  {
    templateKey: "bathroom-accessory-set-installation",
    category: "Bathroom / Caulking / Accessories",
    name: "Bathroom Accessory Set Installation",
    startingPrice: 125,
    description:
      "Install a typical bathroom accessory set (such as a towel bar, ring, and paper holder) on suitable walls. Extra pieces, masonry, or custom layouts may increase the price.",
  },
  {
    templateKey: "grab-bar-installation",
    category: "Bathroom / Caulking / Accessories",
    name: "Grab Bar Installation",
    startingPrice: 100,
    description:
      "Install one grab bar into solid backing on a suitable wall. Starting price is per grab bar. Missing blocking, tile complications, or extra bars may increase the price.",
  },
  {
    templateKey: "small-furniture-assembly",
    category: "Furniture & Assembly",
    name: "Small Furniture Assembly",
    startingPrice: 100,
    description:
      "Assemble a small piece of flat-pack furniture using included hardware. Missing parts, damaged pieces, or extra units may increase the price.",
  },
  {
    templateKey: "medium-furniture-assembly",
    category: "Furniture & Assembly",
    name: "Medium Furniture Assembly",
    startingPrice: 150,
    description:
      "Assemble a medium piece of flat-pack furniture using included hardware. Missing parts, wall anchoring, or extra units may increase the price.",
  },
  {
    templateKey: "large-complex-furniture-assembly",
    category: "Furniture & Assembly",
    name: "Large / Complex Furniture Assembly",
    startingPrice: 225,
    description:
      "Assemble a large or complex furniture piece using included hardware. Multiple units, wall anchoring, or missing parts may increase the price.",
  },
  {
    templateKey: "bed-frame-assembly",
    category: "Furniture & Assembly",
    name: "Bed Frame Assembly",
    startingPrice: 125,
    description:
      "Assemble a standard bed frame using included hardware. Storage beds, unusual sizes, or missing parts may increase the price.",
  },
  {
    templateKey: "shelving-unit-bookcase-assembly",
    category: "Furniture & Assembly",
    name: "Shelving Unit / Bookcase Assembly",
    startingPrice: 125,
    description:
      "Assemble a standard shelving unit or bookcase using included hardware. Wall anchoring, extra units, or missing parts may increase the price.",
  },
  {
    templateKey: "small-window-screen-repair",
    category: "Exterior Repairs",
    name: "Small Window Screen Repair",
    startingPrice: 75,
    description:
      "Repair a small window screen using typical spline and screening. Full re-screen, damaged frames, or several windows may increase the price.",
  },
  {
    templateKey: "window-screen-replacement-re-screen",
    category: "Exterior Repairs",
    name: "Window Screen Replacement / Re-screen",
    startingPrice: 100,
    description:
      "Re-screen a standard window screen in an existing frame. Damaged frames, odd sizes, or several screens may increase the price.",
  },
  {
    templateKey: "screen-door-adjustment-repair",
    category: "Exterior Repairs",
    name: "Screen Door Adjustment / Repair",
    startingPrice: 100,
    description:
      "Adjust or make a minor repair to an existing screen door. Full replacement, frame damage, or new hardware kits may increase the price.",
  },
  {
    templateKey: "exterior-trim-minor-repair",
    category: "Exterior Repairs",
    name: "Exterior Trim Minor Repair",
    startingPrice: 150,
    description:
      "Make a minor repair to exterior trim. Rot, long runs, or paint matching may increase the price. Paint not included unless stated.",
  },
  {
    templateKey: "minor-wood-rot-repair",
    category: "Exterior Repairs",
    name: "Minor Wood Rot Repair",
    startingPrice: 175,
    description:
      "Cut out and patch a small area of exterior wood rot. Large rot, structural framing, or finish work may increase the price.",
  },
  {
    templateKey: "fence-gate-adjustment",
    category: "Exterior Repairs",
    name: "Fence / Gate Adjustment",
    startingPrice: 125,
    description:
      "Adjust an existing fence gate so it opens and latches. Post replacement, new hardware, or sagging sections may increase the price.",
  },
  {
    templateKey: "fence-gate-minor-repair",
    category: "Exterior Repairs",
    name: "Fence / Gate Minor Repair",
    startingPrice: 150,
    description:
      "Make a minor repair to an existing fence or gate. Post replacement, long runs, or new materials may increase the price.",
  },
  {
    templateKey: "mailbox-replacement",
    category: "Exterior Repairs",
    name: "Mailbox Replacement",
    startingPrice: 125,
    description:
      "Replace a standard mailbox using an existing post or mount. New posts, masonry, or custom boxes may increase the price. Mailbox not included unless stated.",
  },
  {
    templateKey: "house-number-installation",
    category: "Exterior Repairs",
    name: "House Number Installation",
    startingPrice: 75,
    description:
      "Install standard house numbers on a suitable exterior surface. Masonry, lighting, or custom layouts may increase the price.",
  },
  {
    templateKey: "cabinet-door-hinge-adjustment",
    category: "Cabinets / Kitchen",
    name: "Cabinet Door / Hinge Adjustment",
    startingPrice: 75,
    description:
      "Adjust a cabinet door and hinges so it lines up and closes. Damaged boxes, replacement doors, or several cabinets may increase the price.",
  },
  {
    templateKey: "cabinet-handle-pull-installation",
    category: "Cabinets / Kitchen",
    name: "Cabinet Handle / Pull Installation",
    startingPrice: 75,
    description:
      "Install standard cabinet handles or pulls on existing doors or drawers. A full kitchen of hardware or unusual spacing may increase the price.",
  },
  {
    templateKey: "cabinet-door-repair",
    category: "Cabinets / Kitchen",
    name: "Cabinet Door Repair",
    startingPrice: 100,
    description:
      "Repair a cabinet door using the existing door and hardware when possible. Replacement doors or finish matching may increase the price.",
  },
  {
    templateKey: "minor-cabinet-repair",
    category: "Cabinets / Kitchen",
    name: "Minor Cabinet Repair",
    startingPrice: 125,
    description:
      "Make a minor repair to a cabinet box, shelf, or face frame. Full replacement or finish matching may increase the price.",
  },
  {
    templateKey: "under-sink-shelf-base-minor-repair",
    category: "Cabinets / Kitchen",
    name: "Under-Sink Shelf / Base Minor Repair",
    startingPrice: 150,
    description:
      "Make a minor repair to an under-sink shelf or cabinet base. Water damage, plumbing leaks, or full replacement may increase the price. Plumbing is not included.",
  },
  {
    templateKey: "ceiling-fan-replacement",
    category: "Fans & Fixtures",
    name: "Ceiling Fan Replacement",
    startingPrice: 150,
    description:
      "Remove an existing standard ceiling fan and install a customer-supplied replacement using the existing approved fan-rated box and existing wiring. Additional charges may apply for high ceilings, troubleshooting, incompatible mounting conditions, specialty fans, or unusual conditions.",
  },
  {
    templateKey: "standard-light-fixture-replacement",
    category: "Fans & Fixtures",
    name: "Standard Light Fixture Replacement",
    startingPrice: 100,
    description:
      "Replace a standard light fixture using the existing box, wiring, and switch. New circuits, rewiring, or incompatible boxes are not included and may require a separate quote where legally permitted.",
  },
  {
    templateKey: "bathroom-vanity-light-replacement",
    category: "Fans & Fixtures",
    name: "Bathroom Vanity Light Replacement",
    startingPrice: 125,
    description:
      "Replace a bathroom vanity light using the existing box, wiring, and switch. New circuits, rewiring, or wall repair are not included.",
  },
  {
    templateKey: "smoke-co-detector-replacement",
    category: "Fans & Fixtures",
    name: "Smoke / CO Detector Replacement",
    startingPrice: 75,
    description:
      "Replace a smoke or CO detector using the existing mounting and, if hardwired, the existing wiring and connectors. New circuits or interconnect wiring are not included.",
  },
  {
    templateKey: "doorbell-replacement-existing-wiring",
    category: "Fans & Fixtures",
    name: "Doorbell Replacement Using Existing Wiring",
    startingPrice: 100,
    description:
      "Replace a doorbell using the existing wiring and chime location. New wiring, transformer upgrades, or smart-home setup beyond a standard swap may increase the price.",
  },
  {
    templateKey: "video-doorbell-existing-wiring",
    category: "Fans & Fixtures",
    name: "Video Doorbell Installation Using Existing Wiring",
    startingPrice: 125,
    description:
      "Install a video doorbell using existing doorbell wiring at the existing location. New wiring, chime kits, or network setup beyond a typical install may increase the price.",
  },
  {
    templateKey: "punch-list-multiple-small-repairs",
    category: "Punch Lists / Small Jobs",
    name: "Punch List / Multiple Small Repairs",
    startingPrice: 150,
    description:
      "Complete a short list of small related repairs in one visit. Extra items, parts, or jobs that need a separate trade may increase the price.",
  },
  {
    templateKey: "minor-hardware-replacement",
    category: "General Home Repairs",
    name: "Minor Hardware Replacement",
    startingPrice: 75,
    description:
      "Replace typical household hardware such as stops, catches, or similar small fittings. Specialty hardware or several rooms may increase the price.",
  },
  {
    templateKey: "weatherstripping-replacement",
    category: "General Home Repairs",
    name: "Weatherstripping Replacement",
    startingPrice: 100,
    description:
      "Replace weatherstripping on a typical door using standard materials. Multiple openings or damaged frames may increase the price.",
  },
  {
    templateKey: "minor-adjustment-repair-visit",
    category: "General Home Repairs",
    name: "Minor Adjustment / Repair Visit",
    startingPrice: 100,
    description:
      "Make a minor adjustment or small repair that fits a standard visit. Extra repairs, parts, or unusual access may increase the price.",
  },
];

export function catalogNameKey(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function starterPricingMode(service: HandymanStarterService) {
  if (service.pricingMode) {
    return service.pricingMode;
  }
  return service.startingPrice == null ? "CUSTOM_QUOTE" : "STARTING_AT";
}

export function isImportableStarterService(service: HandymanStarterService) {
  return (
    starterPricingMode(service) === "CUSTOM_QUOTE" ||
    service.startingPrice != null
  );
}

export function importableStarterServices() {
  return HANDYMAN_STARTER_SERVICES.filter(isImportableStarterService);
}

export function pendingStarterServices() {
  return HANDYMAN_STARTER_SERVICES.filter(
    (service) => !isImportableStarterService(service),
  );
}

export function planStarterCatalogInstall(existingNames: string[]) {
  const existing = new Set(existingNames.map(catalogNameKey));
  const add: HandymanStarterService[] = [];
  const skip: HandymanStarterService[] = [];

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

export const OTHER_SERVICES_CATEGORY = "Other Services";

export function starterCategoryForName(name: string) {
  const key = catalogNameKey(name);
  const match = HANDYMAN_STARTER_SERVICES.find(
    (service) => catalogNameKey(service.name) === key,
  );
  return match?.category ?? OTHER_SERVICES_CATEGORY;
}

export function groupServicesByStarterCategory<
  T extends { name: string; id?: string; templateKey?: string },
>(items: T[]) {
  const groups = new Map<string, T[]>();
  const seen = new Set<string>();

  for (const item of items) {
    const dedupeKey = item.id ?? item.templateKey ?? catalogNameKey(item.name);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    const category = starterCategoryForName(item.name);
    const current = groups.get(category);
    if (current) {
      current.push(item);
    } else {
      groups.set(category, [item]);
    }
  }

  const ordered: Array<{ category: string; items: T[] }> = [];
  for (const category of HANDYMAN_CATALOG_CATEGORIES) {
    const grouped = groups.get(category);
    if (grouped?.length) {
      ordered.push({ category, items: grouped });
    }
  }

  const other = groups.get(OTHER_SERVICES_CATEGORY);
  if (other?.length) {
    ordered.push({ category: OTHER_SERVICES_CATEGORY, items: other });
  }

  return ordered;
}

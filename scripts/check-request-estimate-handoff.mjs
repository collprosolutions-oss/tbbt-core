/**
 * Request → Create Estimate workspace handoff.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-request-estimate-handoff.mjs
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  associateRequestedWorkWithStarterLabor,
  EDIT_BUILD_ESTIMATE_LABEL,
  isPopulatedCustomerRequest,
  REQUEST_ESTIMATE_HANDOFF_TITLE,
  requestedWorkForHandoff,
  shouldCollapseRequestEstimateBuilder,
} = await import("@/lib/request-estimate-handoff");
const { buildEstimateLineCreatesFromRequestItems } = await import(
  "@/lib/request-estimate-draft"
);
const { DECORATIVE_WALL_PANELING_TITLE } = await import(
  "@/lib/estimate-calculators"
);
const { HANDYMAN_STARTER_SERVICES } = await import(
  "@/lib/handyman-starter-catalog"
);
const { ownerVisibleRequestPhotos } = await import(
  "@/lib/intake-quote-handoff"
);
const { joinCatalogDescription, lineCalculatorSnapshot } = await import(
  "@/lib/estimate-line-scope"
);

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
  }
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const doorKnob = HANDYMAN_STARTER_SERVICES.find(
  (row) => row.templateKey === "door-knob-deadbolt-set",
);
const paneling = HANDYMAN_STARTER_SERVICES.find(
  (row) => row.templateKey === "decorative-wall-paneling-finish-carpentry",
);
const ownerPage = readRepo("src/app/(app)/estimates/[estimateId]/page.tsx");
const handoffUi = readRepo("src/components/estimates/request-estimate-handoff.tsx");
const estimateAction = readRepo("src/app/actions/estimate.ts");
const newEstimatePage = readRepo("src/app/(app)/estimates/new/page.tsx");
const customerPage = readRepo("src/app/e/[token]/page.tsx");

console.log("\nSTATIC — Request-created estimate shows customer request first");
check(
  "Customer request card is the first workspace block after the page header",
  ownerPage.indexOf("<RequestEstimateHandoff") <
    ownerPage.indexOf("{EDIT_BUILD_ESTIMATE_LABEL}") &&
    ownerPage.indexOf("<RequestEstimateHandoff") <
      ownerPage.indexOf("ESTIMATE SUMMARY") &&
    ownerPage.indexOf("</PageHeader>") <
      ownerPage.indexOf("<RequestEstimateHandoff") &&
    handoffUi.includes("REQUEST_ESTIMATE_HANDOFF_TITLE") &&
    handoffUi.includes("Requested work") &&
    handoffUi.includes("Quantity:") &&
    handoffUi.includes("Included scope") &&
    handoffUi.includes("Customer notes") &&
    handoffUi.includes("Service address") &&
    readRepo("src/lib/request-estimate-handoff.ts").includes(
      `REQUEST_ESTIMATE_HANDOFF_TITLE = "${REQUEST_ESTIMATE_HANDOFF_TITLE}"`,
    ),
);
check(
  "Detailed builder is collapsed by default for populated request estimates",
  ownerPage.includes("collapseBuilder") &&
    ownerPage.includes("shouldCollapseRequestEstimateBuilder") &&
    ownerPage.includes("<details") &&
    ownerPage.includes("{EDIT_BUILD_ESTIMATE_LABEL}") &&
    !ownerPage.includes("<details open") &&
    ownerPage.includes("Add catalog item") &&
    ownerPage.includes("Add custom item") &&
    ownerPage.includes("LABOR — Calculate & Price the Work") &&
    readRepo("src/lib/request-estimate-handoff.ts").includes(
      `EDIT_BUILD_ESTIMATE_LABEL = "${EDIT_BUILD_ESTIMATE_LABEL}"`,
    ),
);
check(
  "Opening the builder still exposes existing labor/material/other controls",
  ownerPage.includes("laborAndMaterials") &&
    ownerPage.includes("addCatalogAndCustom") &&
    ownerPage.includes("MATERIALS") &&
    ownerPage.indexOf("<SendEstimateButton") <
      ownerPage.indexOf("<RequestEstimateHandoff") &&
    ownerPage.indexOf("<RequestEstimateHandoff") <
      ownerPage.indexOf("ESTIMATE SUMMARY") &&
    ownerPage.indexOf("ESTIMATE SUMMARY") >
      ownerPage.indexOf("{EDIT_BUILD_ESTIMATE_LABEL}"),
);
check(
  "Manual estimates stay expanded and still say Manual estimate",
  ownerPage.includes("Manual estimate") &&
    ownerPage.includes("isDraft && !collapseBuilder ? addCatalogAndCustom") &&
    newEstimatePage.includes("CreateManualEstimateForm") &&
    !newEstimatePage.includes("RequestEstimateHandoff"),
);
check(
  "createEstimate still copies request draft lines with access.scope",
  estimateAction.includes("export async function createEstimate") &&
    estimateAction.includes("addRequestDraftLines") &&
    estimateAction.includes("where: { id: serviceRequestId, ...access.scope }"),
);
check(
  "Customer estimate does not show owner request handoff",
  !customerPage.includes("RequestEstimateHandoff") &&
    !customerPage.includes("EDIT_BUILD_ESTIMATE_LABEL"),
);
check(
  "Photos stay on the owner-only private intake helper",
  ownerPage.includes("ownerVisibleRequestPhotos") &&
    ownerPage.includes("ownerVisibleRequestMeasurements") &&
    handoffUi.includes("RequestIntakeContext"),
);

console.log("\nUNIT — Collapse rules, starter labor, isolation");
check(
  "Populated request from a customer request collapses the builder",
  shouldCollapseRequestEstimateBuilder({
    fromCustomerRequest: true,
    populated: true,
  }) === true,
);
check(
  "Manual estimates do not collapse the builder",
  shouldCollapseRequestEstimateBuilder({
    fromCustomerRequest: false,
    populated: true,
  }) === false,
);
check(
  "Empty linked request does not collapse the builder",
  shouldCollapseRequestEstimateBuilder({
    fromCustomerRequest: true,
    populated: false,
  }) === false,
);
check(
  "Request with catalog items is populated",
  isPopulatedCustomerRequest({
    items: [{ serviceCatalogItem: { name: "Door Knob + Deadbolt Set" } }],
  }) === true,
);
check(
  "Missing request is not populated",
  isPopulatedCustomerRequest(null) === false,
);

const catalogId = "svc-door-knob-set";
const createdLines = buildEstimateLineCreatesFromRequestItems("biz-a", [
  {
    quantity: 1,
    serviceCatalogItem: {
      id: catalogId,
      name: doorKnob.name,
      pricingMode: "STARTING_AT",
      price: doorKnob.startingPrice,
      description: joinCatalogDescription(doorKnob.description, null),
    },
  },
]);
const starterRows = associateRequestedWorkWithStarterLabor(
  requestedWorkForHandoff({
    items: [
      {
        quantity: 1,
        serviceCatalogItem: { id: catalogId, name: doorKnob.name },
      },
    ],
  }),
  createdLines.map((line) => ({
    serviceCatalogItemId: line.serviceCatalogItemId,
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
  })),
);
check("Door Knob starter service is in the catalog fixture", Boolean(doorKnob));
const panelingLines = buildEstimateLineCreatesFromRequestItems("biz-a", [
  {
    quantity: 1,
    serviceCatalogItem: {
      id: "svc-paneling",
      name: paneling.name,
      pricingMode: "CUSTOM_QUOTE",
      price: null,
      description: paneling.description,
    },
  },
]);
const panelingSnapshot = lineCalculatorSnapshot(panelingLines[0]?.description);
check(
  "Request draft binds Decorative Wall Paneling from title/registry without an embedded catalog definition",
  Boolean(paneling) &&
    paneling.name === DECORATIVE_WALL_PANELING_TITLE &&
    !paneling.description.includes("TBBT Calculator Definition") &&
    panelingSnapshot?.calculatorId === "decorative-wall-paneling" &&
    panelingSnapshot?.inputs.wallWidthFt === 0 &&
    panelingSnapshot?.rates.panelRate === 90,
);
check(
  "Starter labor still populates at $125 with the catalog included scope",
  starterRows.length === 1 &&
    starterRows[0].name === "Door Knob + Deadbolt Set" &&
    starterRows[0].quantity === 1 &&
    starterRows[0].startingLaborLabel === "Starting labor: $125.00" &&
    starterRows[0].includedScope?.includes(
      "Replace a matching door knob and deadbolt set using existing preps",
    ) === true,
);
check(
  "Unpriced custom-quote request work does not invent a labor price",
  associateRequestedWorkWithStarterLabor(
    [{ name: "Custom odd job", quantity: 1 }],
    [
      {
        description: "Custom odd job (custom quote — enter price)",
        quantity: 1,
        unitPrice: 0,
      },
    ],
  )[0].startingLaborLabel === null,
);
check(
  "Foreign-business request photos are not shown on this estimate",
  ownerVisibleRequestPhotos({
    businessId: "biz-a",
    serviceRequestId: "req-a",
    photos: [
      {
        id: "p1",
        businessId: "biz-b",
        serviceRequestId: "req-a",
        url: "/api/storage/private/asset-b",
      },
    ],
  }).length === 0,
);
check(
  "Same-business request photos remain visible",
  ownerVisibleRequestPhotos({
    businessId: "biz-a",
    serviceRequestId: "req-a",
    photos: [
      {
        id: "p1",
        businessId: "biz-a",
        serviceRequestId: "req-a",
        url: "/api/storage/private/asset-a",
      },
    ],
  }).length === 1,
);

if (failed) {
  console.error(`\n${failed} check(s) failed, ${passed} passed.`);
  process.exit(1);
}
console.log(`\nAll request-estimate-handoff checks passed (${passed}).`);

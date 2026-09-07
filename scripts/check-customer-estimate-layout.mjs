/**
 * Static layout/branding checks for the customer-facing estimate page.
 * No database access. Does not exercise calculator, approval, version,
 * pricing, or terms-persistence logic.
 *
 * Run with:
 *   node scripts/check-customer-estimate-layout.mjs
 */
import { readFileSync } from "node:fs";

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

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

const page = readRepo("src/app/e/[token]/page.tsx");
const header = readRepo("src/components/estimates/customer-estimate-header.tsx");
const approve = readRepo("src/components/estimates/approve-estimate-button.tsx");
const branding = readRepo("src/lib/business-branding.ts");
const printPage = readRepo("src/app/(invoice-document)/e/[token]/print/page.tsx");
const estimateDocument = readRepo("src/components/estimates/estimate-document.tsx");

console.log("\nSTATIC — Customer estimate responsive layout");

check(
  "Customer estimate uses the tenant logo helper",
  page.includes("getBusinessLogoSrc(estimate.business.slug)"),
);
check("Customer estimate selects business.slug for branding lookup", page.includes("slug: true"));
check("Customer estimate renders CustomerEstimateHeader", page.includes("<CustomerEstimateHeader"));
check("Desktop uses a centered wide container around 1100–1200px", page.includes("max-w-[1200px]"));
check(
  "Available estimate is no longer locked to a mobile-only max-w-md column",
  page.includes("max-w-[1200px]") && !page.includes("<CardTitle>Estimate</CardTitle>"),
);
check(
  "Unavailable page still uses the compact card",
  page.includes("Estimate unavailable") && page.includes('className="w-full max-w-md"'),
);
check("Mobile keeps a stacked single-column layout", page.includes("grid-cols-1"));
check(
  "Tablet/desktop use a 2/3 + 1/3 content grid",
  page.includes("md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"),
);
check(
  "Desktop summary/approval sits in the secondary column",
  page.includes("hidden h-fit md:block") && page.includes("Estimate summary"),
);
check(
  "Mobile approval stays full width after the stacked content",
  page.includes("md:hidden") &&
    page.includes("Approve this estimate") &&
    approve.includes('className="w-full"'),
);
check(
  "Customer terms use the full content width instead of the narrow column",
  page.includes("md:col-span-2") &&
    page.includes("EstimateCustomerPolicies") &&
    page.includes("max-w-none"),
);
check(
  "Header shows logo, business name, ESTIMATE label, status, and total",
  header.includes("logoSrc") &&
    header.includes("businessName") &&
    header.includes("ESTIMATE") &&
    header.includes("StatusBadge") &&
    header.includes("totalLabel"),
);
check(
  "Reusable header does not hardcode CollPro or a brand path",
  !/collpro|\/brand\/collpro/i.test(header),
);
check(
  "CollPro logo mapping stays in business-branding, not estimate components",
  branding.includes("getBusinessLogoSrc") &&
    branding.includes('"/brand/collpro-logo.png"') &&
    !page.includes("/brand/collpro-logo") &&
    !header.includes("/brand/collpro-logo"),
);
check(
  "Customer page still shows title, scope, price, terms, address, and approval",
  page.includes("lineItemTitle") &&
    page.includes("IncludedWorkDisplay") &&
    page.includes("formatMoney") &&
    page.includes("EstimateCustomerPolicies") &&
    page.includes("Service address") &&
    page.includes("ApproveEstimateButton"),
);
check(
  "Internal calculator remains hidden from the customer estimate",
  !page.includes("VariableScopeCalculatorForm") &&
    !page.includes("VariableScopeDefinitionForm") &&
    !page.includes("CalculatorBreakdown") &&
    !page.includes("MaterialTakeoffForm") &&
    !page.includes("panelRate") &&
    !page.includes("contentsHandlingLightRate") &&
    !page.includes("TBBT Work Area Intake") &&
    !page.includes("TBBT Material Takeoff") &&
    !page.includes("customerUnitPrice") &&
    !page.includes("Unit cost (internal)") &&
    !page.includes("Material Markup") &&
    !page.includes("markupPercent") &&
    !page.includes("Apply markup") &&
    !page.includes("lengthInPart") &&
    !header.includes("panelRate"),
);
check(
  "Customer estimate does not load private request photos or owner intake context",
  !page.includes("RequestIntakeContext") &&
    !page.includes("ownerVisibleRequestPhotos") &&
    !page.includes("/api/storage/private/") &&
    !page.includes("Customer-reported / unverified"),
);
check(
  "Approval action and version binding are unchanged",
  page.includes("currentVersionId={currentVersion?.id}") &&
    approve.includes("approveEstimate") &&
    approve.includes("estimateVersionId"),
);
check(
  "Customer estimate offers a Print / PDF path without replacing approval",
  page.includes("/print") &&
    page.includes("Print / PDF") &&
    page.includes("ApproveEstimateButton"),
);
check(
  "Printable estimate uses the document logo helper, not the dark website logo",
  printPage.includes("loadEstimateDocumentByToken") &&
    printPage.includes("EstimateDocument") &&
    !printPage.includes("ApproveEstimateButton") &&
    estimateDocument.includes("ESTIMATE") &&
    estimateDocument.includes("SERVICE ADDRESS") &&
    estimateDocument.includes("TERMS"),
);

console.log(
  failed === 0
    ? `\nAll customer-estimate layout checks passed (${passed}).`
    : `\n${failed} customer-estimate layout check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);

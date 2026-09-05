/**
 * Static layout/branding checks for the Customer Project Portal.
 * No database access. Does not exercise status, invoice, or permission logic.
 *
 * Run with:
 *   node scripts/check-project-portal-layout.mjs
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

const page = readRepo("src/app/p/[token]/page.tsx");
const header = readRepo("src/components/portal/project-portal-header.tsx");
const progress = readRepo("src/components/portal/project-progress-bar.tsx");
const scope = readRepo("src/components/jobs/approved-scope-card.tsx");
const progressLogic = readRepo("src/lib/project-progress.ts");
const branding = readRepo("src/lib/business-branding.ts");

console.log("\nSTATIC — Customer Project Portal responsive layout");

check("Portal page uses the tenant logo helper", page.includes("getBusinessLogoSrc(job.business.slug)"));
check("Portal page selects business.slug for branding lookup", page.includes("slug: true"));
check("Portal page renders ProjectPortalHeader", page.includes("<ProjectPortalHeader"));
check("Portal page uses a wide desktop container", page.includes("max-w-[1200px]"));
check(
  "Portal page no longer uses the mobile-only max-w-md column for the project",
  !page.includes('className="w-full max-w-md space-y-6"'),
);
check("Primary row is a responsive 45/55 grid", page.includes("md:grid-cols-[minmax(0,45fr)_minmax(0,55fr)]"));
check("Secondary cards use a 1/2/3 column grid", page.includes("md:grid-cols-2 xl:grid-cols-3"));
check("Approved scope opts into scan columns only on the portal", page.includes("scanColumns"));
check("Unavailable page still uses the compact card", page.includes('className="w-full max-w-md"'));

check("Header shows Your Project", header.includes("Your Project"));
check("Header accepts logoSrc from the caller", header.includes("logoSrc"));
check(
  "Reusable header does not hardcode CollPro or a brand path",
  !/collpro|\/brand\/collpro/i.test(header),
);
check(
  "Reusable progress bar does not hardcode CollPro",
  !/collpro/i.test(progress),
);
check("Progress bar stays vertical on mobile", progress.includes("flex flex-col"));
check("Progress bar becomes horizontal on large screens", progress.includes("lg:flex-row"));
check("Current step is still labeled (Current)", progress.includes('(Current)'));
check("Progress bar still reads PROJECT_PROGRESS_STEPS", progress.includes("PROJECT_PROGRESS_STEPS"));

check(
  "Status step labels are unchanged",
  progressLogic.includes('ESTIMATE_APPROVED: "Estimate Approved"') &&
    progressLogic.includes('SCHEDULED: "Scheduled"') &&
    progressLogic.includes('WORK_IN_PROGRESS: "Work In Progress"') &&
    progressLogic.includes('COMPLETED: "Completed"') &&
    progressLogic.includes('INVOICE_RECEIPT: "Invoice / Receipt"'),
);
check(
  "Progress mapping still uses real Job/Invoice status only",
  progressLogic.includes('if (invoice)') &&
    progressLogic.includes('return "INVOICE_RECEIPT"') &&
    progressLogic.includes('job.status === "IN_PROGRESS"'),
);

check("Approved scope still has hideFinancials protection", scope.includes("hideFinancials"));
check(
  "Work Order / Field default rows are unchanged when scanColumns is off",
  scope.includes("item.description} × {item.quantity.toString()}"),
);
check(
  "Portal page still uses existing status/invoice helpers",
  page.includes("resolveProjectProgressStep") &&
    page.includes("customerFacingJobStatusLabel") &&
    page.includes("shouldShowPayInvoice") &&
    page.includes("resolveApprovedWorkOrderScope"),
);
check(
  "CollPro logo mapping stays in business-branding, not portal components",
  branding.includes('getBusinessLogoSrc') &&
    !page.includes("/brand/collpro-logo") &&
    !header.includes("/brand/collpro-logo"),
);

console.log(
  failed === 0
    ? `\nAll project-portal layout checks passed (${passed}).`
    : `\n${failed} project-portal layout check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);

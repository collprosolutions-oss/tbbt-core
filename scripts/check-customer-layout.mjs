/**
 * Customer record layout: existing history stays, RecordNav is added
 * as compact related-record journey (not a second module nav).
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-customer-layout.mjs
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

const page = readRepo("src/app/(app)/customers/[customerId]/page.tsx");
const listPage = readRepo("src/app/(app)/customers/page.tsx");
const recordNav = readRepo("src/components/record-nav.tsx");
const nav = readRepo("src/lib/nav.ts");

console.log("\nSTATIC — Customer history is preserved");
check("Customer profile title is unchanged", page.includes('description="Customer profile"'));
check("Contact information card remains", page.includes("<CardTitle>Contact information</CardTitle>"));
check("Service addresses history remains", page.includes("<CardTitle>Service addresses</CardTitle>"));
check("Service requests history remains", page.includes("<CardTitle>Service requests</CardTitle>"));
check("Estimates history remains", page.includes("<CardTitle>Estimates</CardTitle>"));
check("Jobs history remains", page.includes("<CardTitle>Jobs</CardTitle>"));
check("Invoices history remains", page.includes("<CardTitle>Invoices</CardTitle>"));
check("Review activity history remains", page.includes("<CardTitle>Review activity</CardTitle>"));
check(
  "Customer still loads requests, estimates, jobs, and invoices by customer FK",
  page.includes("serviceRequests: { orderBy: { createdAt: \"desc\" } }") &&
    page.includes("estimates: { orderBy: { createdAt: \"desc\" } }") &&
    page.includes("jobs: { orderBy: { createdAt: \"desc\" } }") &&
    page.includes("invoices: { orderBy: { createdAt: \"desc\" } }"),
);
check(
  "History Open actions still use existing record routes",
  page.includes('href={`/estimates/${estimate.id}`}') &&
    page.includes('href={`/jobs/${job.id}`}') &&
    page.includes('href={`/invoices/${invoice.id}`}') &&
    page.includes('href={`/requests/${request.id}`}'),
);

console.log("\nSTATIC — RecordNav on the customer record");
check("Customer page renders RecordNav", page.includes("<RecordNav"));
check("Customer page loads the journey from scoped FKs", page.includes("loadRecordJourney"));
check(
  "RecordNav is compact and phone-friendly",
  recordNav.includes("flex-col") &&
    recordNav.includes("sm:flex-row") &&
    recordNav.includes("flex-wrap"),
);
check(
  "Customers list page is unchanged as the module index",
  listPage.includes("Search customers") || listPage.includes('placeholder="Search customers..."'),
);
check("No new global APP_NAV item was added for RecordNav", !nav.includes("RecordNav"));

if (failed > 0) {
  console.error(`\ncustomer-layout check failed: ${failed} failure(s)`);
  process.exit(1);
}

console.log(`\ncustomer-layout check passed (${passed} checks)`);

/**
 * Customer record contact view + job-history clarity on a phone.
 *
 * Call/Text/Email come from recorded values and canonical helpers only.
 * Job rows stay distinguishable with recorded address and/or date.
 * No invented job titles. Tenant scope stays on the existing page access.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-customer.mjs
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { smsHref, telHref } = await import("@/lib/directions");

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

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

const form = readRepo("src/components/customers/edit-customer-form.tsx");
const page = readRepo("src/app/(app)/customers/[customerId]/page.tsx");
const listPage = readRepo("src/app/(app)/customers/page.tsx");

function emailHref(email) {
  const value = email?.trim();
  return value ? `mailto:${value}` : null;
}

console.log("\nUNIT — Recorded customer contact helpers");
const recordedPhone = "(239) 357-8199";
const recordedEmail = "owner@example.com";
check(
  "Call href uses recorded phone only",
  telHref(recordedPhone) === `tel:${recordedPhone}` &&
    telHref(null) === null &&
    telHref("") === null &&
    telHref("   ") === null,
);
check(
  "Text href uses canonical smsHref digits when present",
  smsHref(recordedPhone) === "sms:2393578199" &&
    smsHref(null) === null &&
    smsHref("") === null &&
    smsHref("   ") === null &&
    smsHref("---") === null,
);
check(
  "Email href uses recorded email only",
  emailHref(recordedEmail) === `mailto:${recordedEmail}` &&
    emailHref("  pat@example.com  ") === "mailto:pat@example.com" &&
    emailHref(null) === null &&
    emailHref("") === null &&
    emailHref("   ") === null,
);

console.log("\nSTATIC — Customer contact view mode");
check(
  "View mode uses canonical telHref for Call",
  form.includes('import { smsHref, telHref } from "@/lib/directions"') &&
    form.includes("const callHref = telHref(customer.phone)") &&
    form.includes("<a href={callHref}>Call</a>"),
);
check(
  "View mode exposes Text only through canonical smsHref",
  form.includes("const textHref = smsHref(customer.phone)") &&
    form.includes("<a href={textHref}>Text</a>"),
);
check(
  "View mode uses mailto from the recorded email",
  form.includes("function emailHref(") &&
    form.includes("`mailto:${value}`") &&
    form.includes("const mailHref = emailHref(customer.email)") &&
    form.includes("<a href={mailHref}>Email</a>"),
);
check(
  "Call/Text/Email render only when a recorded href exists",
  form.includes("{callHref || textHref ? (") &&
    form.includes("{callHref ? (") &&
    form.includes("{textHref ? (") &&
    form.includes("{mailHref ? (") &&
    !form.includes("No phone on file"),
);
check(
  "Contact actions use phone tap targets",
  form.includes('const PHONE_ACTION_CLASS = "min-h-11 min-w-11 px-4"') &&
    form.includes("className={PHONE_ACTION_CLASS}"),
);
check(
  "Recorded phone/email still display, including None",
  form.includes("Phone: {customer.phone || \"None\"}") &&
    form.includes("Email: {customer.email || \"None\"}"),
);

console.log("\nSTATIC — Customer job history is distinguishable without invented titles");
const jobsCardStart = page.indexOf('<Card id="customer-jobs">');
const jobsCardEnd = page.indexOf('<Card id="customer-invoices">');
const jobsCard = page.slice(jobsCardStart, jobsCardEnd);
check("Jobs history card still exists", jobsCardStart >= 0 && jobsCard.includes("<CardTitle>Jobs</CardTitle>"));
check(
  "Job title remains the recorded status only",
  jobsCard.includes("title={<StatusBadge status={job.status} />}") &&
    !jobsCard.includes("Job title") &&
    !jobsCard.includes('"Job"') &&
    !jobsCard.includes("Untitled"),
);
check(
  "Job rows use recorded address when the customer property is on file",
  jobsCard.includes("property.id === job.propertyId") &&
    jobsCard.includes("formatAddress(recordedProperty)") &&
    jobsCard.includes("subtitle={recordedAddress || undefined}"),
);
check(
  "Job rows keep the recorded scheduled or created date",
  jobsCard.includes("job.scheduledAt") &&
    jobsCard.includes("formatDateTime(job.scheduledAt)") &&
    jobsCard.includes("formatDate(job.createdAt)"),
);
check(
  "Job Open still uses the existing job route and a phone tap target",
  jobsCard.includes("href={`/jobs/${job.id}`}") &&
    jobsCard.includes('className="min-h-11 min-w-11 px-4"'),
);
check(
  "Jobs query is still the customer FK list",
  page.includes('jobs: { orderBy: { createdAt: "desc" } }'),
);

console.log("\nSTATIC — Tenant scope and customers list isolation");
check(
  "Customer page still uses management access + tenant scope",
  page.includes("requireManagementPageAccess") &&
    page.includes("where: { id: customerId, ...access.scope }") &&
    page.includes("access.assertOwned(customer)"),
);
check(
  "This change does not rewrite the customers list page",
  listPage.includes("Search customers") || listPage.includes('placeholder="Search customers..."'),
);

if (failed > 0) {
  console.error(`\ncustomer check failed: ${failed} failure(s)`);
  process.exit(1);
}

console.log(`\ncustomer check passed (${passed} checks)`);
